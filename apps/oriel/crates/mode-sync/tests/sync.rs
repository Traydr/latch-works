//! `sync.spec.ts`'s five cases against a small Pane View on a local port
//! (`oriel_core_sync::testing::FakePaneView`), which serves the sync routes the generated schema
//! names and checks each signed upload as S3 does. `stack.rs` runs the same cases against the
//! local compose stack.

mod support;

use std::fs;

use gpui_kit::TestAppContext;
use oriel_core_sync::testing::FakePaneView;

use support::{Target, run_sync_spec};

const TOKEN: &str = "fake-sync-token-0123456789";

#[gpui_kit::test]
fn sync_spec_against_a_local_pane_view(cx: &mut TestAppContext) {
    let scratch = tempfile::tempdir().unwrap();
    // The seeded archive: what an earlier push of another folder left in Pane View.
    let archive = scratch.path().join("archive");
    let seeded = [
        ("root-image.png", b"root image".as_slice()),
        ("folder/a.jpg", b"a still"),
        ("folder/b.jpg", b"another still"),
        ("videos/clip.mp4", b"a clip"),
    ];
    let server = FakePaneView::start(TOKEN);
    for (path, bytes) in seeded {
        let file = archive.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, bytes).unwrap();
        server.seed(path, bytes);
    }
    // The two images the spec pushes on top of it.
    let source = scratch.path().join("lockstep-source");
    fs::create_dir_all(source.join("desk")).unwrap();
    fs::write(source.join("desk/desk-1.png"), b"first desk image").unwrap();
    fs::write(source.join("desk/desk-2.png"), b"second desk image, longer").unwrap();

    let target = Target {
        url: server.url(),
        token: TOKEN.to_owned(),
        source,
        archive,
        source_items: vec!["desk/desk-1.png".to_owned(), "desk/desk-2.png".to_owned()],
    };
    run_sync_spec(cx, &target, &scratch.path().join("data"));

    // Every upload carried the length and checksum headers Pane View signed (plan 026).
    let uploads = server.uploads();
    assert_eq!(uploads.len(), 2);
    for upload in uploads {
        assert!(upload.contains_key("x-amz-checksum-sha256"));
        assert!(upload.contains_key("content-length"));
    }
    // Plan, push, plan and prune: one sync run each for push and prune, both finalized.
    let runs = server.runs();
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|run| run.outcome.is_some()));
}
