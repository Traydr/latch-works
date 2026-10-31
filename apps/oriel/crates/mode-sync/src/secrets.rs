//! Where Sync keeps tokens: Electron Oriel's `FileSecretStorage`, in the same format.
//!
//! A random 32-byte key sits in `secret-storage.key` in Sync's folder, readable by the user
//! alone (0600, in a 0700 folder). A token is sealed with AES-256-GCM under a fresh 12-byte nonce
//! and stored as `nonce | tag | ciphertext`, which the profile file holds in base64. Electron
//! Oriel chose a key file over the Keychain because an unsigned build's signature changes with
//! each rebuild and the Keychain asked again every time; the same holds for Oriel.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use aes_gcm::aead::AeadInPlace as _;
use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce, Tag};

const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// The key file's name in Sync's folder.
pub const KEY_FILE_NAME: &str = "secret-storage.key";

/// Seals and opens tokens with the key in one file, made on first use.
///
/// The key is read once and kept, as `FileSecretStorage` keeps it, since the profile list asks
/// whether each token opens every time it draws.
#[derive(Clone, Debug)]
pub struct FileSecretStorage {
    key_path: PathBuf,
    key: Arc<OnceLock<Vec<u8>>>,
}

impl FileSecretStorage {
    pub fn new(key_path: PathBuf) -> Self {
        Self {
            key_path,
            key: Arc::default(),
        }
    }

    /// The storage for Sync's folder: its key in `<folder>/secret-storage.key`.
    pub fn in_folder(folder: &Path) -> Self {
        Self::new(folder.join(KEY_FILE_NAME))
    }

    pub fn key_path(&self) -> &Path {
        &self.key_path
    }

    /// `iv | tag | ciphertext` of `plain_text`.
    pub fn encrypt(&self, plain_text: &str) -> io::Result<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(self.load_key()?)
            .map_err(|_| io::Error::other("Sync's secret key has the wrong length"))?;
        let mut iv = [0u8; IV_BYTES];
        getrandom::fill(&mut iv).map_err(io::Error::other)?;
        let mut data = plain_text.as_bytes().to_vec();
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut data)
            .map_err(|_| io::Error::other("the token could not be encrypted"))?;
        let mut sealed = Vec::with_capacity(IV_BYTES + TAG_BYTES + data.len());
        sealed.extend_from_slice(&iv);
        sealed.extend_from_slice(&tag);
        sealed.extend_from_slice(&data);
        Ok(sealed)
    }

    /// The token in `iv | tag | ciphertext`, or an error when it was sealed with another key or
    /// was changed.
    pub fn decrypt(&self, sealed: &[u8]) -> io::Result<String> {
        if sealed.len() < IV_BYTES + TAG_BYTES {
            return Err(io::Error::other("the sealed token is too short"));
        }
        let cipher = Aes256Gcm::new_from_slice(self.load_key()?)
            .map_err(|_| io::Error::other("Sync's secret key has the wrong length"))?;
        let (iv, rest) = sealed.split_at(IV_BYTES);
        let (tag, data) = rest.split_at(TAG_BYTES);
        let mut data = data.to_vec();
        cipher
            .decrypt_in_place_detached(Nonce::from_slice(iv), b"", &mut data, Tag::from_slice(tag))
            .map_err(|_| io::Error::other("the token could not be unlocked with this key"))?;
        String::from_utf8(data).map_err(io::Error::other)
    }

    /// The key, made on first use. Creation never overwrites a key another process wrote first.
    fn load_key(&self) -> io::Result<&[u8]> {
        if let Some(key) = self.key.get() {
            return Ok(key);
        }
        let key = match fs::read(&self.key_path) {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::NotFound => self.create_key()?,
            Err(error) => return Err(error),
        };
        if key.len() != KEY_BYTES {
            return Err(io::Error::other(format!(
                "Sync's secret key at {} is not {KEY_BYTES} bytes",
                self.key_path.display()
            )));
        }
        Ok(self.key.get_or_init(|| key))
    }

    fn create_key(&self) -> io::Result<Vec<u8>> {
        if let Some(folder) = self.key_path.parent() {
            create_private_folder(folder)?;
        }
        let mut key = [0u8; KEY_BYTES];
        getrandom::fill(&mut key).map_err(io::Error::other)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        match options.open(&self.key_path) {
            Ok(mut file) => {
                file.write_all(&key)?;
                file.sync_all()?;
                set_private(&self.key_path)?;
            }
            // Another writer won; its key is the one to use.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        fs::read(&self.key_path)
    }
}

fn create_private_folder(folder: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(folder)
}

#[cfg(unix)]
fn set_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private(_: &Path) -> io::Result<()> {
    Ok(())
}
