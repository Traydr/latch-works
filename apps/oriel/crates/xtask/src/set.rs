//! A pinned set of libraries on disk, as `vendor` and `libmpv` make them: `<root>/<id>/` holds
//! the libraries, their licences under `licenses/`, `manifest.json` and `SHA256SUMS`, which a
//! later run and the bundle check the files against. A set is laid out in `<id>.partial` and
//! renamed whole, and `<root>/current` points at the newest (`oriel_core_paths::CURRENT`), where
//! the app finds it while developing.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};

use crate::support::{sha256_file, symlink};

const CHECKSUMS_FILE: &str = "SHA256SUMS";

pub const MANIFEST_FILE: &str = "manifest.json";

/// A set being laid out.
pub struct Staging {
    root: PathBuf,
    id: String,
    partial: PathBuf,
}

impl Staging {
    /// An empty `<root>/<id>.partial` to lay the set out in.
    pub fn begin(root: &Path, id: &str) -> Result<Self> {
        let partial = root.join(format!("{id}.partial"));
        if partial.exists() {
            fs::remove_dir_all(&partial)?;
        }
        fs::create_dir_all(&partial)?;
        Ok(Self {
            root: root.to_path_buf(),
            id: id.to_owned(),
            partial,
        })
    }

    pub fn folder(&self) -> &Path {
        &self.partial
    }

    /// Writes the manifest and each library's SHA-256 (`(sha256, file)`, the file relative to the
    /// set), puts the set in place of any older copy of it, points `current` at it, and returns
    /// its folder.
    pub fn finish(self, manifest: &str, libraries: &[(String, String)]) -> Result<PathBuf> {
        fs::write(self.partial.join(MANIFEST_FILE), manifest)?;
        let sums: String = libraries
            .iter()
            .map(|(sha256, file)| format!("{sha256}  {file}\n"))
            .collect();
        fs::write(self.partial.join(CHECKSUMS_FILE), sums)?;
        let folder = self.root.join(&self.id);
        if folder.exists() {
            fs::remove_dir_all(&folder)?;
        }
        fs::rename(&self.partial, &folder)?;
        point_current_at(&self.root, &self.id)?;
        Ok(folder)
    }
}

/// Copies `file` into the set's `licenses/<name>/`.
pub fn copy_licence(set: &Path, name: &str, file: &Path) -> Result<()> {
    let folder = set.join("licenses").join(name);
    fs::create_dir_all(&folder)?;
    let target = folder.join(file.file_name().context("a licence file has no name")?);
    fs::copy(file, &target).with_context(|| format!("copying {}", file.display()))?;
    Ok(())
}

/// Whether `folder` holds a whole set whose files still hash to what was recorded, with `entry`
/// among them.
pub fn is_intact(folder: &Path, entry: &str) -> bool {
    if !folder.join(MANIFEST_FILE).is_file() {
        return false;
    }
    let Ok(sums) = fs::read_to_string(folder.join(CHECKSUMS_FILE)) else {
        return false;
    };
    let lines: Vec<&str> = sums.split('\n').filter(|line| !line.is_empty()).collect();
    for line in &lines {
        let Some((sha256, file)) = line.split_once("  ") else {
            return false;
        };
        let well_formed = sha256.len() == 64
            && sha256
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
            && !file.is_empty()
            && !file.chars().any(char::is_whitespace);
        if !well_formed {
            return false;
        }
        let target = folder.join(file);
        if !target.is_file() || sha256_file(&target).ok().as_deref() != Some(sha256) {
            return false;
        }
    }
    lines
        .iter()
        .any(|line| line.ends_with(&format!("  {entry}")))
}

/// Points `<root>/current` at `id`, replacing the link in one rename.
pub fn point_current_at(root: &Path, id: &str) -> Result<()> {
    let current = root.join(oriel_core_paths::CURRENT);
    let next = root.join(format!("{}.next", oriel_core_paths::CURRENT));
    let _ = fs::remove_file(&next);
    symlink(Path::new(id), &next)?;
    fs::rename(&next, &current)?;
    Ok(())
}
