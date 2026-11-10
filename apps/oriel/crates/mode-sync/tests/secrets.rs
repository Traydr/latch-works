//! Sync's settings and tokens in the format Electron Oriel wrote them (plan 063, "Same
//! formats"): Rust writes a profile with a token in a temp folder and reads it back, reads the
//! files Electron Oriel wrote (`conformance/lockstep-core/secret-storage/electron`, kept as they
//! were when Electron Oriel was removed), and keeps each profile's last run as the file has it.
//! The token is made up for this check.

use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_paths::DataRoot;
use oriel_mode_sync::{FileSecretStorage, ProfileInput, ProfileStore, TokenState};

const TOKEN: &str = "conformance-sync-token-0123456789abcdef";

fn electron_files() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/lockstep-core/secret-storage/electron")
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
    let data = DataRoot::at(folder.path().to_path_buf()).unwrap();
    let (mut store, error) = ProfileStore::open(&data);
    assert_eq!(error, None);
    let profile = store.create(input()).unwrap();

    let settings = fs::read_to_string(data.sync_settings()).unwrap();
    assert!(settings.contains("Conformance archive"));
    assert!(
        !settings.contains(TOKEN),
        "the token reached the settings file"
    );
    let key = fs::metadata(data.sync_secret_key()).unwrap();
    assert_eq!(key.len(), 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(key.permissions().mode() & 0o777, 0o600);
    }

    let (reopened, error) = ProfileStore::open(&data);
    assert_eq!(error, None);
    assert_eq!(reopened.active_profile_id(), Some(profile.id.as_str()));
    assert_eq!(reopened.token_state(&profile.id), TokenState::Saved);
    assert_eq!(reopened.api_token(&profile.id).as_deref(), Some(TOKEN));

    // A token sealed under another key does not open: it is unreadable, not wrong.
    let other = FileSecretStorage::new(folder.path().join("other.key"));
    let sealed = other.encrypt(TOKEN).unwrap();
    assert!(
        FileSecretStorage::new(data.sync_secret_key())
            .decrypt(&sealed)
            .is_err()
    );
}

#[test]
fn reads_the_profile_and_token_electron_oriel_wrote() {
    let folder = tempfile::tempdir().unwrap();
    let data = DataRoot::at(folder.path().to_path_buf()).unwrap();
    fs::create_dir_all(data.sync()).unwrap();
    for file in [data.sync_settings(), data.sync_secret_key()] {
        fs::copy(electron_files().join(file.file_name().unwrap()), &file).unwrap();
    }
    let (store, error) = ProfileStore::open(&data);
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
    let data = DataRoot::at(folder.path().to_path_buf()).unwrap();
    fs::create_dir_all(data.sync()).unwrap();
    fs::write(data.sync_settings(), "{ not json").unwrap();
    let (store, error) = ProfileStore::open(&data);
    let error = error.expect("an error");
    assert!(error.contains("was kept as"), "{error}");
    assert!(store.profiles().is_empty());
    let kept: Vec<String> = fs::read_dir(data.sync())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("lockstep-settings.corrupt-"))
        .collect();
    assert_eq!(kept.len(), 1);
    assert!(!data.sync_settings().exists());
}

#[test]
fn keeps_each_profiles_last_run_as_the_file_has_it() {
    let folder = tempfile::tempdir().unwrap();
    let data = DataRoot::at(folder.path().to_path_buf()).unwrap();
    fs::create_dir_all(data.sync()).unwrap();
    let profile = |id: &str, last_run: &str| {
        format!(
            r#"{{"apiUrl":"http://127.0.0.1:3100","id":"{id}","lastRun":{last_run},"name":"{id}","sourceRoot":"/Volumes/{id}"}}"#
        )
    };
    let counts = r#"{"delete":2,"keep":3,"update":1,"upload":4}"#;
    let written = format!(
        r#"{{"activeProfileId":"push","profiles":[{},{},{},{}]}}"#,
        profile(
            "push",
            &format!(
                r#"{{"action":"push","completedAt":"2026-11-01T10:00:00.000Z","failed":1,"planCounts":{counts},"profileId":"push","pushed":4,"status":"failed"}}"#
            )
        ),
        profile(
            "prune",
            &format!(
                r#"{{"action":"prune","completedAt":"2026-11-01T10:05:00.000Z","failed":0,"message":"1 delete(s) skipped because the file is back in the source folder.","planCounts":{counts},"profileId":"prune","pushed":1,"skipped":1,"status":"completed"}}"#
            )
        ),
        profile(
            "doctor",
            r#"{"action":"doctor","completedAt":"2026-11-01T10:10:00.000Z","failed":0,"message":"All checks passed.","profileId":"doctor","pushed":0,"status":"completed"}"#
        ),
        profile(
            "plan",
            &format!(
                r#"{{"action":"plan","completedAt":"2026-11-01T10:15:00.000Z","failed":0,"planCounts":{counts},"pushed":0,"status":"cancelled"}}"#
            )
        ),
    );
    fs::write(data.sync_settings(), &written).unwrap();

    let (mut store, error) = ProfileStore::open(&data);
    assert_eq!(error, None);
    let pushed = store.profile("push").unwrap().last_run.clone().unwrap();
    assert_eq!((pushed.applied, pushed.failed), (4, 1));
    let pruned = store.profile("prune").unwrap().last_run.clone().unwrap();
    assert_eq!((pruned.applied, pruned.skipped), (1, Some(1)));

    // Any save writes the whole file again.
    store.set_active("push").unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(data.sync_settings()).unwrap()).unwrap();
    let written: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(saved, written);
}
