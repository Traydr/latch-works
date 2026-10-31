//! What the archive's AVIF files are made of, through the vendored libavif: the container and
//! colour boxes jSquash's encoder writes, no orientation or profile, alpha only where a pixel is
//! not opaque, and the same bytes every time at one thread. Skips, saying so, until the set is
//! vendored (`cargo run -p xtask -- vendor libavif`).

use oriel_avif::{ARCHIVE_AVIF_OPTIONS, Channels, Libavif, Samples, Still};

fn libavif() -> Option<&'static Libavif> {
    match Libavif::get() {
        Ok(libavif) => Some(libavif),
        Err(error) => {
            eprintln!("skipped: {error}");
            None
        }
    }
}

/// A smooth gradient with some texture, `channels` samples per pixel, alpha from `alpha`.
fn gradient(width: u32, height: u32, channels: usize, alpha: impl Fn(u32, u32) -> u8) -> Vec<u8> {
    let mut samples = Vec::with_capacity(width as usize * height as usize * channels);
    for y in 0..height {
        for x in 0..width {
            samples.push((x * 255 / width) as u8);
            samples.push((y * 255 / height) as u8);
            samples.push(((x * 7 + y * 13) % 256) as u8);
            if channels == 4 {
                samples.push(alpha(x, y));
            }
        }
    }
    samples
}

/// The payload of the first box named `name`, found by its four-character code.
fn find_box<'a>(file: &'a [u8], name: &[u8; 4]) -> Option<&'a [u8]> {
    let at = file.windows(4).position(|window| window == name)?;
    let size = u32::from_be_bytes(file[at - 4..at].try_into().ok()?) as usize;
    file.get(at + 4..at - 4 + size)
}

fn contains(file: &[u8], text: &[u8]) -> bool {
    file.windows(text.len()).any(|window| window == text)
}

#[test]
fn an_archive_still_is_an_srgb_avif_without_orientation_or_profile() {
    let Some(libavif) = libavif() else { return };
    let (width, height) = (96, 64);
    let rgba = gradient(width, height, 4, |_, _| 255);
    let still = Still {
        width,
        height,
        channels: Channels::Rgba,
        samples: Samples::Eight(&rgba),
    };
    let file = libavif.encode(&still, &ARCHIVE_AVIF_OPTIONS, 1).unwrap();

    assert_eq!(&file[4..12], b"ftypavif");
    let ispe = find_box(&file, b"ispe").expect("an ispe box");
    assert_eq!(&ispe[4..8], &width.to_be_bytes());
    assert_eq!(&ispe[8..12], &height.to_be_bytes());

    // jSquash sets only the matrix: unspecified primaries and transfer, BT.601, full range.
    let colr = find_box(&file, b"colr").expect("a colr box");
    assert_eq!(&colr[..4], b"nclx");
    assert_eq!(&colr[4..10], &[0, 2, 0, 2, 0, 6]);
    assert_eq!(colr[10] & 0x80, 0x80, "full range");

    // The pixels are already turned and in sRGB: nothing for a reader to apply.
    for name in [b"irot", b"imir", b"Exif", b"prof", b"rICC"] {
        assert!(!contains(&file, name), "{}", String::from_utf8_lossy(name));
    }
    // An opaque still has no alpha plane.
    assert!(!contains(&file, b"auxiliary:alpha"));
}

#[test]
fn rgb_and_opaque_rgba_give_the_same_file_every_time() {
    let Some(libavif) = libavif() else { return };
    let (width, height) = (80, 48);
    let rgba = gradient(width, height, 4, |_, _| 255);
    let rgb = gradient(width, height, 3, |_, _| 255);
    let encode = |channels, samples| {
        let still = Still {
            width,
            height,
            channels,
            samples: Samples::Eight(samples),
        };
        libavif.encode(&still, &ARCHIVE_AVIF_OPTIONS, 1).unwrap()
    };
    let first = encode(Channels::Rgba, &rgba);
    assert_eq!(first, encode(Channels::Rgba, &rgba));
    assert_eq!(first, encode(Channels::Rgb, &rgb));
}

#[test]
fn transparency_is_kept_as_an_alpha_plane() {
    let Some(libavif) = libavif() else { return };
    let (width, height) = (64, 64);
    let rgba = gradient(width, height, 4, |x, _| if x < 32 { 0 } else { 255 });
    let still = Still {
        width,
        height,
        channels: Channels::Rgba,
        samples: Samples::Eight(&rgba),
    };
    let file = libavif.encode_archive(&still, 1).unwrap();
    assert!(contains(
        &file,
        b"urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"
    ));
}

#[test]
fn bad_settings_are_refused_before_libavif_sees_them() {
    let Some(libavif) = libavif() else { return };
    let rgba = gradient(8, 8, 4, |_, _| 255);
    let still = Still {
        width: 8,
        height: 8,
        channels: Channels::Rgba,
        samples: Samples::Eight(&rgba),
    };
    let deep = oriel_avif::AvifEncodeOptions {
        bit_depth: 16,
        ..ARCHIVE_AVIF_OPTIONS
    };
    assert!(libavif.encode(&still, &deep, 1).is_err());
    let odd = oriel_avif::AvifEncodeOptions {
        subsample: 7,
        ..ARCHIVE_AVIF_OPTIONS
    };
    assert!(libavif.encode(&still, &odd, 1).is_err());
}
