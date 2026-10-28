//! Checks `media.ts`'s port against `conformance/media-domain/media.json`.

mod support;

use oriel_core_domain::{
    GallerySortMode, IMAGE_EXTENSIONS, MediaType, PDF_EXTENSIONS, VIDEO_EXTENSIONS,
    detect_media_type, get_extension, is_supported_media_file,
};
use serde::Deserialize;
use support::{GeneratedWith, check, describe, fail_with, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaVectors {
    generated_with: GeneratedWith,
    image_extensions: Vec<String>,
    video_extensions: Vec<String>,
    pdf_extensions: Vec<String>,
    media_types: Vec<MediaType>,
    gallery_sort_modes: Vec<GallerySortMode>,
    files: Vec<FileCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCase {
    file_name: String,
    extension: String,
    media_type: MediaType,
    supported: bool,
}

fn vectors() -> MediaVectors {
    read_vectors("media.json")
}

#[test]
fn lists_the_extensions_kinds_and_sort_modes_the_typescript_lists() {
    let vectors = vectors();
    assert_eq!(vectors.image_extensions, IMAGE_EXTENSIONS);
    assert_eq!(vectors.video_extensions, VIDEO_EXTENSIONS);
    assert_eq!(vectors.pdf_extensions, PDF_EXTENSIONS);
    assert_eq!(vectors.media_types, MediaType::ALL);
    assert_eq!(vectors.gallery_sort_modes, GallerySortMode::ALL);
}

#[test]
fn reads_file_names_as_the_typescript_does() {
    let vectors = vectors();
    let mut problems = Vec::new();
    for case in &vectors.files {
        let name = || describe(&case.file_name);
        check(
            &mut problems,
            || format!("extension of {}", name()),
            &case.extension,
            &get_extension(&case.file_name),
        );
        check(
            &mut problems,
            || format!("media type of {}", name()),
            &case.media_type,
            &detect_media_type(&case.file_name),
        );
        check(
            &mut problems,
            || format!("whether {} is supported", name()),
            &case.supported,
            &is_supported_media_file(&case.file_name),
        );
    }
    fail_with(
        &problems,
        "file names read differently",
        &vectors.generated_with,
    );
}
