//! A still's fingerprint through the libvips the app loads, on pictures drawn here: the same
//! picture always gets the same 64 bits, a resized and recompressed copy lands within Balanced's distance
//! of its original, and another picture lands past Loose's. Bit-for-bit agreement with sharp is
//! not asked for; what Duplicates relies on is that copies come out close and pictures apart.
//!
//! Needs libvips (`cargo run -p xtask -- vendor`); without it, it says so and passes.

use std::path::{Path, PathBuf};

use oriel_core_tidy::contract::SimilarityLevel;
use oriel_core_tidy::similarity::{Fingerprint, Hash64, Vips, fingerprint_still, still_threshold};
use oriel_test_archive::image::codecs::png::CompressionType;
use oriel_test_archive::image::imageops::{self, FilterType};
use oriel_test_archive::{save_jpeg, save_png, variant_picture};

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
    let Ok((vips, _, _)) = Vips::open_located() else {
        eprintln!("skipped: fingerprints need libvips (cargo run -p xtask -- vendor)");
        return;
    };
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
