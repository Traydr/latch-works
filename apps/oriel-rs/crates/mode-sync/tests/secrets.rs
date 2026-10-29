//! Sync's tokens in the same format in Oriel RS and Electron Oriel (plan 063, "Same formats"): Rust
//! writes a profile with a token in a temp folder and reads it back, and reads the files Electron
//! Oriel's `FileSecretStorage` and `ProfileService` wrote
//! (`conformance/lockstep-core/secret-storage/electron`, from
//! `apps/oriel/tests/sync/main/secretStorage.conformance.test.ts`). With
//! `ORIEL_RS_UPDATE_VECTORS=1` it also writes its own into `.../oriel-rs`, which that suite reads.
//! The token is made up for this check.

use std::fs;
use std::path::{Path, PathBuf};

use oriel_mode_sync::profiles::{ProfileInput, ProfileStore, SETTINGS_FILE_NAME, TokenState};
use oriel_mode_sync::secrets::{FileSecretStorage, KEY_FILE_NAME};

const TOKEN: &str = "conformance-sync-token-0123456789abcdef";

fn conformance(side: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/lockstep-core/secret-storage")
        .join(side)
}

fn input() -> ProfileInput {
    ProfileInput {
        name: "Conformance archive".to_owned(),
        api_url: "http://127.0.0.1:3100".to_owned(),
        source_root: "/Volumes/Archive".to_owned(),
        token: Some(TOKEN.to_owned()),
    }
}

#[test]
fn writes_a_token_it_reads_back_sealed_under_a_private_key_never_in_the_clear() {
    let folder = tempfile::tempdir().unwrap();
    let (mut store, error) = ProfileStore::open(folder.path());
    assert_eq!(error, None);
    let profile = store.create(input()).unwrap();

    let settings = fs::read_to_string(folder.path().join(SETTINGS_FILE_NAME)).unwrap();
    assert!(settings.contains("Conformance archive"));
    assert!(
        !settings.contains(TOKEN),
        "the token reached the settings file"
    );
    let key = fs::metadata(folder.path().join(KEY_FILE_NAME)).unwrap();
    assert_eq!(key.len(), 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(key.permissions().mode() & 0o777, 0o600);
    }

    let (reopened, error) = ProfileStore::open(folder.path());
    assert_eq!(error, None);
    assert_eq!(reopened.active_profile_id(), Some(profile.id.as_str()));
    assert_eq!(reopened.token_state(&profile.id), TokenState::Saved);
    assert_eq!(reopened.api_token(&profile.id).as_deref(), Some(TOKEN));

    // A token sealed under another key does not open: it is unreadable, not wrong.
    let other = FileSecretStorage::new(folder.path().join("other.key"));
    let sealed = other.encrypt(TOKEN).unwrap();
    assert!(
        FileSecretStorage::in_folder(folder.path())
            .decrypt(&sealed)
            .is_err()
    );

    if std::env::var("ORIEL_RS_UPDATE_VECTORS").as_deref() == Ok("1") {
        let target = conformance("oriel-rs");
        fs::create_dir_all(&target).unwrap();
        for file in [SETTINGS_FILE_NAME, KEY_FILE_NAME] {
            fs::copy(folder.path().join(file), target.join(file)).unwrap();
        }
    }
}

#[test]
fn reads_the_profile_and_token_electron_oriel_wrote() {
    let folder = tempfile::tempdir().unwrap();
    for file in [SETTINGS_FILE_NAME, KEY_FILE_NAME] {
        fs::copy(conformance("electron").join(file), folder.path().join(file)).unwrap();
    }
    let (store, error) = ProfileStore::open(folder.path());
    assert_eq!(error, None);
    let [profile] = store.profiles() else {
        panic!("one profile, got {:?}", store.profiles());
    };
    assert_eq!(profile.name, "Conformance archive");
    assert_eq!(profile.api_url, "http://127.0.0.1:3100");
    assert_eq!(profile.source_root, "/Volumes/Archive");
    assert_eq!(store.active_profile_id(), Some(profile.id.as_str()));
    assert_eq!(store.token_state(&profile.id), TokenState::Saved);
    assert_eq!(store.api_token(&profile.id).as_deref(), Some(TOKEN));
}

#[test]
fn a_settings_file_that_does_not_read_is_set_aside() {
    let folder = tempfile::tempdir().unwrap();
    fs::write(folder.path().join(SETTINGS_FILE_NAME), "{ not json").unwrap();
    let (store, error) = ProfileStore::open(folder.path());
    let error = error.expect("an error");
    assert!(error.contains("was kept as"), "{error}");
    assert!(store.profiles().is_empty());
    let kept: Vec<String> = fs::read_dir(folder.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("lockstep-settings.corrupt-"))
        .collect();
    assert_eq!(kept.len(), 1);
    assert!(!folder.path().join(SETTINGS_FILE_NAME).exists());
}
