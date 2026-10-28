//! What the viewer and the thumbnails rely on: the archive's formats decode, at the size asked,
//! the right way up, with straight alpha; and the WebP encoder's output reads back. The stills
//! are written by ImageIO itself, which encodes AVIF and HEIC on this Mac but not WebP.

use std::ffi::c_void;
use std::path::{Path, PathBuf};

use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, kCGColorSpaceSRGB,
};
use objc2_image_io::{CGImageDestination, kCGImagePropertyOrientation};

use super::{Still, WebpSettings, decode};

/// A folder of its own under the temp folder for one test.
fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-media-still-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

/// Straight BGRA: red on the left half, blue on the right, so turning the picture shows.
fn halves(width: usize, height: usize, alpha: u8) -> Vec<u8> {
    let mut bgra = Vec::with_capacity(width * height * 4);
    for _ in 0..height {
        for x in 0..width {
            if x < width / 2 {
                bgra.extend_from_slice(&[0, 0, 255, alpha]);
            } else {
                bgra.extend_from_slice(&[255, 0, 0, alpha]);
            }
        }
    }
    bgra
}

/// A Core Graphics image of straight BGRA pixels, premultiplied as Core Graphics wants.
fn cg_image(width: usize, height: usize, bgra: &[u8]) -> CFRetained<CGImage> {
    let mut premultiplied: Vec<u8> = bgra
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|pixel| {
            let alpha = u16::from(pixel[3]);
            let scale = |channel: u8| ((u16::from(channel) * alpha + 127) / 255) as u8;
            [scale(pixel[0]), scale(pixel[1]), scale(pixel[2]), pixel[3]]
        })
        .collect();
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB })).unwrap();
    let info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
    unsafe {
        let context = CGBitmapContextCreate(
            premultiplied.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            info,
        )
        .unwrap();
        CGBitmapContextCreateImage(Some(&context)).unwrap()
    }
}

/// Writes `image` as `uti` (`public.avif`, `public.heic`, …), with an EXIF orientation if given.
fn write(path: &Path, uti: &str, image: &CGImage, orientation: Option<i32>) {
    let url = CFURL::from_file_path(path).unwrap();
    let uti = CFString::from_str(uti);
    unsafe {
        let destination = CGImageDestination::with_url(&url, &uti, 1, None).unwrap();
        let value = orientation.map(CFNumber::new_i32);
        let properties = value.as_ref().map(|value| {
            let keys: [&CFString; 1] = [kCGImagePropertyOrientation];
            let values: [&CFType; 1] = [value];
            CFDictionary::from_slices(&keys, &values)
        });
        destination.add_image(image, properties.as_deref().map(|p| p.as_opaque()));
        assert!(
            destination.finalize(),
            "ImageIO could not write {}",
            path.display()
        );
    }
}

fn pixel(still: &Still, x: u32, y: u32) -> [u8; 4] {
    let at = ((y * still.width() + x) * 4) as usize;
    still.bgra()[at..at + 4].try_into().unwrap()
}

fn is_red(pixel: [u8; 4]) -> bool {
    pixel[2] > 200 && pixel[0] < 60
}

fn is_blue(pixel: [u8; 4]) -> bool {
    pixel[0] > 200 && pixel[2] < 60
}

#[test]
fn the_archive_formats_decode_at_the_size_asked() {
    let folder = scratch("formats");
    let image = cg_image(640, 360, &halves(640, 360, 255));
    for (name, uti) in [
        ("still.avif", "public.avif"),
        ("still.heic", "public.heic"),
        ("still.jpg", "public.jpeg"),
        ("still.png", "public.png"),
    ] {
        let path = folder.join(name);
        write(&path, uti, &image, None);

        let still = decode(&path, 320).unwrap_or_else(|error| panic!("{name}: {error:#}"));
        assert_eq!((still.width(), still.height()), (320, 180), "{name}");
        assert!(still.is_opaque(), "{name} has no alpha");
        assert!(
            is_red(pixel(&still, 40, 90)),
            "{name}: {:?}",
            pixel(&still, 40, 90)
        );
        assert!(
            is_blue(pixel(&still, 280, 90)),
            "{name}: {:?}",
            pixel(&still, 280, 90)
        );

        // A size above the still's own decodes it at its own size; nothing is enlarged.
        let full = decode(&path, 4096).unwrap();
        assert_eq!((full.width(), full.height()), (640, 360), "{name}");
    }
}

#[test]
fn applies_the_exif_orientation() {
    let folder = scratch("orientation");
    let path = folder.join("turned.jpg");
    // Orientation 6: the picture is stored on its side and shows turned 90° clockwise.
    write(
        &path,
        "public.jpeg",
        &cg_image(64, 32, &halves(64, 32, 255)),
        Some(6),
    );

    let still = decode(&path, 1024).unwrap();
    assert_eq!((still.width(), still.height()), (32, 64));
    // The stored left (red) half is now on top.
    assert!(is_red(pixel(&still, 16, 8)), "{:?}", pixel(&still, 16, 8));
    assert!(
        is_blue(pixel(&still, 16, 56)),
        "{:?}",
        pixel(&still, 16, 56)
    );
}

#[test]
fn keeps_alpha_straight() {
    let folder = scratch("alpha");
    let path = folder.join("half-clear.png");
    write(
        &path,
        "public.png",
        &cg_image(16, 16, &halves(16, 16, 128)),
        None,
    );

    let still = decode(&path, 1024).unwrap();
    assert!(!still.is_opaque());
    let [blue, green, red, alpha] = pixel(&still, 2, 2);
    assert!(alpha.abs_diff(128) <= 1, "alpha {alpha}");
    // Premultiplied, red would read about 128; straight, it is back near 255.
    assert!(
        red >= 250 && green <= 2 && blue <= 2,
        "{:?}",
        [blue, green, red, alpha]
    );
}

#[test]
fn webp_reads_back_with_or_without_alpha() {
    let folder = scratch("webp");
    let opaque = Still::from_bgra(48, 24, halves(48, 24, 255), true).unwrap();
    let clear = Still::from_bgra(48, 24, halves(48, 24, 128), false).unwrap();

    for (name, still, settings) in [
        ("lossy.webp", &opaque, WebpSettings::lossy(92.0, 5)),
        ("lossless.webp", &clear, WebpSettings::lossless(0)),
    ] {
        let bytes = still.encode_webp(settings).unwrap();
        assert_eq!(&bytes[..4], b"RIFF", "{name}");
        assert_eq!(&bytes[8..12], b"WEBP", "{name}");
        let path = folder.join(name);
        std::fs::write(&path, &bytes).unwrap();

        let decoded = decode(&path, 1024).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (48, 24), "{name}");
        assert_eq!(decoded.is_opaque(), still.is_opaque(), "{name}");
        assert!(
            is_red(pixel(&decoded, 4, 12)),
            "{name}: {:?}",
            pixel(&decoded, 4, 12)
        );
    }
}

#[test]
fn a_file_that_is_not_a_still_is_an_error() {
    let folder = scratch("not-a-still");
    let path = folder.join("notes.jpg");
    std::fs::write(&path, b"not a picture").unwrap();
    assert!(decode(&path, 256).is_err());
    assert!(decode(&folder.join("missing.avif"), 256).is_err());
}
