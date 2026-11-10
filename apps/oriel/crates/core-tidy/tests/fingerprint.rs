//! A still's fingerprint through the libvips the app loads, on pictures drawn here: the same
//! picture always gets the same 64 bits, a resized and recompressed copy lands within Balanced's distance
//! of its original, and another picture lands past Loose's. Bit-for-bit agreement with sharp is
//! not asked for; what Duplicates relies on is that copies come out close and pictures apart.
//!
//! Needs libvips (`cargo run -p xtask -- vendor`): see [`support::media`].

use std::path::{Path, PathBuf};

use oriel_core_tidy::contract::SimilarityLevel;
use oriel_core_tidy::internals::{
    Fingerprint, Hash64, fingerprint_still, open_libvips, still_threshold,
};
use oriel_test_archive::image::codecs::png::CompressionType;
use oriel_test_archive::image::imageops::{self, FilterType};
use oriel_test_archive::{save_jpeg, save_png, variant_picture};
use oriel_vips::Vips;

use crate::support;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn hash(vips: &Vips, path: &Path) -> Hash64 {
    match fingerprint_still(vips, path).unwrap() {
        Fingerprint::Still(hash) => hash,
        other => panic!("{} is a still, not {other:?}", path.display()),
    }
}

#[test]
fn copies_of_a_still_hash_close_and_other_pictures_apart() {
    if support::media().is_none() {
        return;
    }
    let vips = open_libvips().unwrap();
    let scratch = Scratch(
        std::env::temp_dir().join(format!("oriel-tidy-fingerprint-{}", std::process::id())),
    );
    std::fs::create_dir_all(&scratch.0).unwrap();
    let page = variant_picture(7);
    let original = scratch.0.join("page.png");
    save_png(&page, &original, CompressionType::Default);
    let resized = scratch.0.join("page-small.jpg");
    save_jpeg(
        &imageops::resize(&page, 320, 240, FilterType::Lanczos3),
        &resized,
        70,
    );
    let other = scratch.0.join("other.png");
    save_png(&variant_picture(11), &other, CompressionType::Default);

    // The same picture drawn again into a file of its own.
    let again = scratch.0.join("page-again.png");
    save_png(&variant_picture(7), &again, CompressionType::Default);

    let first = hash(&vips, &original);
    assert_eq!(
        hash(&vips, &original),
        first,
        "the same file, the same bits"
    );
    assert_eq!(
        hash(&vips, &again),
        first,
        "the same picture, the same bits"
    );
    let copy = hash(&vips, &resized);
    assert!(
        first.distance(copy) <= still_threshold(SimilarityLevel::Balanced),
        "the resized copy is {} bits away",
        first.distance(copy)
    );
    let apart = hash(&vips, &other);
    assert!(
        first.distance(apart) > still_threshold(SimilarityLevel::Loose),
        "another picture is only {} bits away",
        first.distance(apart)
    );
}

/// Stills as Convert leaves them, from the hardware decoder and from libvips' own loader: the same
/// bytes at every step, whichever route each takes.
#[cfg(target_os = "macos")]
#[test]
fn the_hardware_route_makes_what_libvips_makes() {
    use oriel_avif::{Channels, Libavif, Samples, Still};
    use oriel_vips::hardware_avif::Declined;

    if support::media().is_none() {
        return;
    }
    let (hardware, libavif) = (open_libvips().unwrap(), Libavif::get().unwrap());
    let software = open_libvips().unwrap().without_hardware_decoder();
    let folder = std::env::temp_dir().join(format!("oriel-hardware-avif-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let scratch = Scratch(folder);
    let picture = variant_picture(0);
    let (width, height) = picture.dimensions();
    let opaque: Vec<u8> = picture
        .as_raw()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect();
    let with_alpha: Vec<u8> = opaque
        .as_chunks::<3>()
        .0
        .iter()
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 200])
        .collect();
    let encode = |name: &str, channels, samples| {
        let path = scratch.0.join(name);
        let still = Still {
            width,
            height,
            channels,
            samples: Samples::Eight(samples),
        };
        std::fs::write(&path, libavif.encode_archive(&still, 1).unwrap()).unwrap();
        path
    };
    let plain = encode("plain.avif", Channels::Rgb, &opaque);
    let alpha = encode("alpha.avif", Channels::Rgba, &with_alpha);

    let route = hardware.hardware_route(&plain).unwrap();
    if matches!(route, Err(Declined::Decoder)) && in_a_virtual_machine() {
        // GitHub's macOS runners are virtual Macs whose VideoToolbox reports a hardware AV1 decoder
        // and then refuses every frame, so no still here can take the route this test compares.
        eprintln!("skipped: this virtual Mac's VideoToolbox refuses to decode AV1");
        return;
    }
    assert!(
        matches!(route, Ok(()) | Err(Declined::NoDecoder)),
        "a plain still should take the route on a Mac with the decoder: {route:?}"
    );
    assert!(hardware.hardware_route(&alpha).unwrap().is_err());
    for path in [&plain, &alpha] {
        assert_eq!(
            hardware.rgba_pixels(path).unwrap(),
            software.rgba_pixels(path).unwrap()
        );
        assert_eq!(
            hardware.grey_pixels(path, 32, None).unwrap(),
            software.grey_pixels(path, 32, None).unwrap()
        );
        assert_eq!(hash(&hardware, path), hash(&software, path));
    }
}

/// Whether this Mac runs under a hypervisor (`kern.hv_vmm_present`).
#[cfg(target_os = "macos")]
fn in_a_virtual_machine() -> bool {
    std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "kern.hv_vmm_present"])
        .output()
        .is_ok_and(|output| output.stdout.trim_ascii() == b"1")
}
