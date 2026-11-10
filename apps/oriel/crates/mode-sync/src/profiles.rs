//! Sync's profiles: each pairs a source folder with a Pane View URL and its sync token, in
//! `lockstep-settings.json` in Sync's folder, in the format Electron Oriel wrote, so its file
//! still reads as it is.
//!
//! The token is sealed by [`FileSecretStorage`] and stored as `encryptedToken`, never in the
//! clear. A file that does not read is set aside as `lockstep-settings.corrupt-<time>.json`
//! rather than overwritten, so its profiles and tokens can still be recovered by hand.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use oriel_core_domain::format::iso_timestamp;
use oriel_core_sync::{PlanCounts, RunAction, RunStatus, RunSummary};
use serde::{Deserialize, Serialize};

use oriel_core_paths::DataRoot;

use crate::secrets::{FileSecretStorage, OpenError};

/// One profile as the file holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub api_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_token: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<LastRun>,
    pub name: String,
    pub source_root: String,
}

/// How the profile's last run ended, as the file keeps it (`lastRun`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub action: RunAction,
    pub completed_at: String,
    pub failed: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_counts: Option<PlanCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// What a push sent or a prune deleted; the file names both `pushed`.
    #[serde(rename = "pushed")]
    pub applied: usize,
    /// Prune only: planned deletes left alone because the file is back in the source folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<usize>,
    pub status: RunStatus,
}

impl LastRun {
    fn of(summary: &RunSummary, profile_id: &str) -> Self {
        Self {
            action: summary.action,
            completed_at: iso_timestamp(summary.completed_at),
            failed: summary.failed,
            message: summary.message.clone(),
            plan_counts: summary.plan_counts,
            profile_id: Some(profile_id.to_owned()),
            applied: summary.applied,
            skipped: summary.skipped,
            status: summary.status,
        }
    }
}

/// The file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFile {
    pub active_profile_id: Option<String>,
    pub profiles: Vec<Profile>,
}

/// Whether a profile's token can be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenState {
    /// No token saved.
    None,
    /// Saved, and it opens with this folder's key.
    Saved,
    /// Saved, but sealed with another key or damaged: it must be entered again.
    Unreadable,
    /// Saved, but Sync's secret key cannot be read, so no token opens or can be saved.
    KeyUnreadable,
}

/// A new profile.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileInput {
    pub name: String,
    pub api_url: String,
    pub source_root: String,
    pub token: Option<String>,
}

/// An edit: an empty field keeps the saved value; a token replaces
/// the saved one, and `clear_token` forgets it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfilePatch {
    pub name: Option<String>,
    pub api_url: Option<String>,
    pub source_root: Option<String>,
    pub token: Option<String>,
    pub clear_token: bool,
}

/// The profiles and their tokens.
#[derive(Debug)]
pub struct ProfileStore {
    file_path: PathBuf,
    secrets: FileSecretStorage,
    state: ProfileFile,
    /// Each profile's token, as it opened when the profiles were last loaded or saved.
    tokens: HashMap<String, TokenState>,
    /// Why Sync's secret key could not be read, when a token needed it.
    key_error: Option<String>,
}

impl ProfileStore {
    /// The profiles `data` keeps, and the error that kept them, or their tokens, from loading, if
    /// any. A missing file is no profiles yet.
    pub fn open(data: &DataRoot) -> (Self, Option<String>) {
        let mut store = Self {
            file_path: data.sync_settings(),
            secrets: FileSecretStorage::new(data.sync_secret_key()),
            state: ProfileFile::default(),
            tokens: HashMap::new(),
            key_error: None,
        };
        let error = match fs::read_to_string(&store.file_path) {
            Ok(raw) => match serde_json::from_str::<ProfileFile>(&raw) {
                Ok(state) => {
                    store.state = state;
                    None
                }
                Err(error) => Some(store.set_aside(&error.to_string())),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => Some(format!(
                "{} could not be read: {error}",
                store.file_path.display()
            )),
        };
        store.open_tokens();
        let error = error.or_else(|| store.key_error.clone());
        (store, error)
    }

    /// Works out whether each profile's token opens, once, rather than at every frame.
    fn open_tokens(&mut self) {
        self.key_error = None;
        let mut tokens = HashMap::with_capacity(self.state.profiles.len());
        for profile in &self.state.profiles {
            let state = match self.open_token(profile) {
                Ok(None) => TokenState::None,
                Ok(Some(_)) => TokenState::Saved,
                Err(OpenError::Sealed) => TokenState::Unreadable,
                Err(OpenError::Key(error)) => {
                    self.key_error = Some(format!(
                        "Sync's secret key could not be read, so saved tokens cannot be \
                         unlocked: {error}"
                    ));
                    TokenState::KeyUnreadable
                }
            };
            tokens.insert(profile.id.clone(), state);
        }
        self.tokens = tokens;
    }

    fn open_token(&self, profile: &Profile) -> Result<Option<String>, OpenError> {
        let Some(sealed) = &profile.encrypted_token else {
            return Ok(None);
        };
        let sealed = BASE64.decode(sealed).map_err(|_| OpenError::Sealed)?;
        self.secrets.decrypt(&sealed).map(Some)
    }

    /// Moves a file that failed to load out of the way, so the next save starts a new one.
    fn set_aside(&self, failure: &str) -> String {
        let stamp = iso_timestamp(SystemTime::now()).replace([':', '.'], "-");
        let kept = self
            .file_path
            .with_file_name(format!("lockstep-settings.corrupt-{stamp}.json"));
        match fs::rename(&self.file_path, &kept) {
            Ok(()) => format!(
                "{failure}. The unreadable settings file was kept as {}.",
                kept.display()
            ),
            Err(error) => format!("{failure}. The file could not be set aside either: {error}"),
        }
    }

    pub fn profiles(&self) -> &[Profile] {
        &self.state.profiles
    }

    pub fn active_profile_id(&self) -> Option<&str> {
        self.state.active_profile_id.as_deref()
    }

    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.state.profiles.iter().find(|profile| profile.id == id)
    }

    pub fn active_profile(&self) -> Option<&Profile> {
        self.profile(self.active_profile_id()?)
    }

    /// The profile's token, if one is saved and opens.
    pub fn api_token(&self, id: &str) -> Option<String> {
        self.open_token(self.profile(id)?).ok().flatten()
    }

    pub fn token_state(&self, id: &str) -> TokenState {
        self.tokens.get(id).copied().unwrap_or(TokenState::None)
    }

    /// Why Sync's secret key could not be read, if a saved token needed it and it could not.
    pub fn key_error(&self) -> Option<&str> {
        self.key_error.as_deref()
    }

    fn seal(&self, token: &str) -> io::Result<String> {
        Ok(BASE64.encode(self.secrets.encrypt(token)?))
    }

    /// Adds a profile, active if none was. Its token, if given, is sealed before anything is
    /// written.
    pub fn create(&mut self, input: ProfileInput) -> anyhow::Result<Profile> {
        validate_required(&input.name, "Profile name")?;
        validate_required(&input.api_url, "Pane View API URL")?;
        validate_required(&input.source_root, "Source folder")?;
        let token = input.token.filter(|token| !token.is_empty());
        let profile = Profile {
            api_url: input.api_url,
            encrypted_token: token.as_deref().map(|token| self.seal(token)).transpose()?,
            id: new_id(),
            last_run: None,
            name: input.name,
            source_root: input.source_root,
        };
        let mut next = self.state.clone();
        next.profiles.push(profile.clone());
        if next.active_profile_id.is_none() {
            next.active_profile_id = Some(profile.id.clone());
        }
        self.commit(next)?;
        Ok(profile)
    }

    /// Applies an edit. Moving the source folder or the URL drops the last run, which described
    /// the old target.
    pub fn update(&mut self, id: &str, patch: ProfilePatch) -> anyhow::Result<Profile> {
        let token = patch.token.filter(|token| !token.is_empty());
        anyhow::ensure!(
            !(patch.clear_token && token.is_some()),
            "Provide a new token or clear the saved one, not both."
        );
        let current = self
            .profile(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Profile not found"))?;
        let pick = |value: Option<String>, saved: &str| {
            value
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| saved.to_owned())
        };
        let mut next = Profile {
            api_url: pick(patch.api_url, &current.api_url),
            name: pick(patch.name, &current.name),
            source_root: pick(patch.source_root, &current.source_root),
            ..current.clone()
        };
        if next.api_url != current.api_url || next.source_root != current.source_root {
            next.last_run = None;
        }
        if let Some(token) = token {
            next.encrypted_token = Some(self.seal(&token)?);
        } else if patch.clear_token {
            next.encrypted_token = None;
        }
        let mut state = self.state.clone();
        for profile in &mut state.profiles {
            if profile.id == id {
                *profile = next.clone();
            }
        }
        self.commit(state)?;
        Ok(next)
    }

    /// Removes a profile and its token. Deleting the active profile activates its neighbour in
    /// list order, or none when it was the last.
    pub fn delete(&mut self, id: &str) -> anyhow::Result<()> {
        let index = self
            .state
            .profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or_else(|| anyhow::anyhow!("Profile not found"))?;
        let mut state = self.state.clone();
        state.profiles.remove(index);
        if state.active_profile_id.as_deref() == Some(id) {
            state.active_profile_id = state
                .profiles
                .get(index.min(state.profiles.len().saturating_sub(1)))
                .map(|profile| profile.id.clone());
        }
        self.commit(state)
    }

    pub fn set_active(&mut self, id: &str) -> anyhow::Result<()> {
        anyhow::ensure!(self.profile(id).is_some(), "Profile not found");
        let mut state = self.state.clone();
        state.active_profile_id = Some(id.to_owned());
        self.commit(state)
    }

    /// Keeps a run's summary on its profile, as "Last push 18 ok, 0 failed · 5 min ago" shows.
    pub fn record_last_run(&mut self, id: &str, summary: &RunSummary) -> anyhow::Result<()> {
        if self.profile(id).is_none() {
            return Ok(());
        }
        let mut state = self.state.clone();
        for profile in &mut state.profiles {
            if profile.id == id {
                profile.last_run = Some(LastRun::of(summary, id));
            }
        }
        self.commit(state)
    }

    /// Writes `state` and adopts it once it is on disk. The file is replaced by a rename, so a
    /// failed write never leaves half a file.
    fn commit(&mut self, state: ProfileFile) -> anyhow::Result<()> {
        save(&self.file_path, &state)?;
        let tokens_changed = state.profiles.len() != self.state.profiles.len()
            || state
                .profiles
                .iter()
                .zip(&self.state.profiles)
                .any(|(next, now)| {
                    next.id != now.id || next.encrypted_token != now.encrypted_token
                });
        self.state = state;
        if tokens_changed {
            self.open_tokens();
        }
        Ok(())
    }
}

fn validate_required(value: &str, label: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!value.is_empty(), "{label} is required.");
    Ok(())
}

fn save(file_path: &Path, state: &ProfileFile) -> io::Result<()> {
    if let Some(folder) = file_path.parent() {
        fs::create_dir_all(folder)?;
    }
    let mut temporary = file_path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", new_id()));
    let temporary = PathBuf::from(temporary);
    let mut json = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    json.push('\n');
    let written = fs::write(&temporary, json).and_then(|()| fs::rename(&temporary, file_path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// A version-4 UUID, as `randomUUID()` makes them.
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
