//! What every mode's window shares: which mode shows, whether the sidebar is the rail, the work
//! each mode reports, which section of Settings is open, and the folders the modes work on.

use gpui_kit::assets::IconName;
use gpui_kit::{AppContext as _, Context, Entity};

use crate::activity::Activity;
use crate::folders::KnownFolder;

/// Oriel's three modes, in the switcher's order (⌘1–3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ModeId {
    View,
    Tidy,
    Sync,
}

impl ModeId {
    pub const ALL: [ModeId; 3] = [ModeId::View, ModeId::Tidy, ModeId::Sync];

    pub fn label(self) -> &'static str {
        match self {
            ModeId::View => "View",
            ModeId::Tidy => "Tidy",
            ModeId::Sync => "Sync",
        }
    }

    /// The mode's name in Electron Oriel's settings and messages (`ModeIdSchema`): `view`, `tidy`,
    /// `sync`.
    pub fn key(self) -> &'static str {
        match self {
            ModeId::View => "view",
            ModeId::Tidy => "tidy",
            ModeId::Sync => "sync",
        }
    }

    /// The mode a [`Self::key`] names, if it names one.
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.key() == key)
    }

    pub fn icon(self) -> IconName {
        match self {
            ModeId::View => IconName::Images,
            ModeId::Tidy => IconName::WandSparkles,
            ModeId::Sync => IconName::RefreshCw,
        }
    }

    pub fn shortcut(self) -> &'static str {
        match self {
            ModeId::View => "⌘1",
            ModeId::Tidy => "⌘2",
            ModeId::Sync => "⌘3",
        }
    }

    pub fn index(self) -> usize {
        match self {
            ModeId::View => 0,
            ModeId::Tidy => 1,
            ModeId::Sync => 2,
        }
    }
}

/// Work a mode is doing, shown on its switcher button while another mode is on screen (plan 059):
/// a ring for work with a known end, a dot for work without one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ModeActivity {
    /// A scan or an analysis: a dot.
    Working,
    /// A push or a Tidy change, `0.0..=1.0` done: a ring, and the Dock's progress. Quitting waits
    /// for it.
    Progress(f32),
}

impl ModeActivity {
    /// The work in words after the mode's name, as the switcher's tooltip says it:
    /// "Tidy · 40% done", "View · working".
    pub fn describe(self, mode: ModeId) -> String {
        match self {
            ModeActivity::Working => format!("{} · working", mode.label()),
            ModeActivity::Progress(_) => format!("{} · {}% done", mode.label(), self.percent()),
        }
    }

    /// How far the work has got, in whole percent; 0 for work without a known end.
    pub fn percent(self) -> u32 {
        match self {
            ModeActivity::Working => 0,
            ModeActivity::Progress(ratio) => (ratio.clamp(0., 1.) * 100.).round() as u32,
        }
    }

    /// What changes on screen: the switcher redraws at most a hundred times over a run, however
    /// often the mode reports.
    fn shown(this: Option<Self>) -> Option<(bool, u32)> {
        this.map(|activity| {
            (
                matches!(activity, ModeActivity::Progress(_)),
                activity.percent(),
            )
        })
    }
}

/// A section of the one Settings page: the app's own, or one mode's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SettingsSection {
    General,
    Mode(ModeId),
}

impl SettingsSection {
    pub const ALL: [SettingsSection; 4] = [
        SettingsSection::General,
        SettingsSection::Mode(ModeId::View),
        SettingsSection::Mode(ModeId::Tidy),
        SettingsSection::Mode(ModeId::Sync),
    ];

    pub fn label(self) -> &'static str {
        match self {
            SettingsSection::General => "General",
            SettingsSection::Mode(mode) => mode.label(),
        }
    }

    /// Electron Oriel's name for the section (`data-settings-section`): `general`, `view`, …
    pub fn key(self) -> &'static str {
        match self {
            SettingsSection::General => "general",
            SettingsSection::Mode(mode) => mode.key(),
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            SettingsSection::General => IconName::SlidersHorizontal,
            SettingsSection::Mode(mode) => mode.icon(),
        }
    }
}

/// The shell's state, one per window. Modes observe it; a hidden mode's own state simply lives
/// on in its entity.
pub struct ShellState {
    mode: ModeId,
    rail: bool,
    activity: [Option<ModeActivity>; 3],
    jobs: Entity<Activity>,
    settings: Option<SettingsSection>,
    folders: Vec<KnownFolder>,
}

impl ShellState {
    pub fn new(mode: ModeId, rail: bool, cx: &mut Context<Self>) -> Self {
        Self {
            mode,
            rail,
            activity: [None; 3],
            jobs: cx.new(|_| Activity::default()),
            settings: None,
            folders: Vec::new(),
        }
    }

    /// Every mode's jobs, running and queued, which the shell draws at the window's bottom
    /// right; each mode publishes its own there with [`Activity::set_jobs`].
    pub fn jobs(&self) -> &Entity<Activity> {
        &self.jobs
    }

    /// Every folder a mode works on that is still there, with the modes that use it.
    pub fn known_folders(&self) -> &[KnownFolder] {
        &self.folders
    }

    /// The folders the other modes work on and `mode` does not, for its empty state to offer
    /// (`useOfferedFolders`). Each mode keeps its own folders; the shell only proposes them.
    pub fn offered_to(&self, mode: ModeId) -> Vec<KnownFolder> {
        self.folders
            .iter()
            .filter(|folder| !folder.is_used_by(mode))
            .cloned()
            .collect()
    }

    /// The modes that use `folder`, resolved as the known folders are; none for a folder no mode
    /// uses or one that is gone.
    pub fn modes_using(&self, folder: &std::path::Path) -> &[ModeId] {
        self.folders
            .iter()
            .find(|known| known.path() == folder)
            .map_or(&[], KnownFolder::modes)
    }

    /// The shell gathers the modes' folders here whenever one of them may have changed.
    pub fn set_known_folders(&mut self, folders: Vec<KnownFolder>, cx: &mut Context<Self>) {
        if self.folders != folders {
            self.folders = folders;
            cx.notify();
        }
    }

    /// What `mode` is doing, if anything.
    pub fn activity(&self, mode: ModeId) -> Option<ModeActivity> {
        self.activity[mode.index()]
    }

    /// Modes report their work here; the shell draws it, shows it in the Dock, and keeps the app
    /// open for a [`ModeActivity::Progress`]. Report `None` when the work ends.
    pub fn set_activity(
        &mut self,
        mode: ModeId,
        activity: Option<ModeActivity>,
        cx: &mut Context<Self>,
    ) {
        let slot = &mut self.activity[mode.index()];
        if *slot == activity {
            return;
        }
        let changed = ModeActivity::shown(*slot) != ModeActivity::shown(activity);
        *slot = activity;
        if changed {
            cx.notify();
        }
    }

    /// Whether a mode is running work that quitting must wait for: a push or a Tidy change.
    pub fn is_busy(&self) -> bool {
        self.activity
            .iter()
            .any(|activity| matches!(activity, Some(ModeActivity::Progress(_))))
    }

    /// The mean of the modes' progress, `0.0..=1.0`, while any reports some; the Dock shows it.
    pub fn progress(&self) -> Option<f32> {
        let ratios: Vec<f32> = self
            .activity
            .iter()
            .filter_map(|activity| match activity {
                Some(ModeActivity::Progress(ratio)) => Some(ratio.clamp(0., 1.)),
                _ => None,
            })
            .collect();
        (!ratios.is_empty()).then(|| ratios.iter().sum::<f32>() / ratios.len() as f32)
    }

    pub fn mode(&self) -> ModeId {
        self.mode
    }

    /// Whether the sidebar is compact, the rail of icons: the owner's choice alone, the same in
    /// every mode and at any window size.
    pub fn rail(&self) -> bool {
        self.rail
    }

    /// The section of Settings on screen, or `None` while Settings is closed.
    pub fn settings(&self) -> Option<SettingsSection> {
        self.settings
    }

    /// Shows `mode`, closing Settings.
    pub fn go(&mut self, mode: ModeId, cx: &mut Context<Self>) {
        if self.mode != mode || self.settings.is_some() {
            self.mode = mode;
            self.settings = None;
            cx.notify();
        }
    }

    pub fn toggle_rail(&mut self, cx: &mut Context<Self>) {
        self.rail = !self.rail;
        cx.notify();
    }

    /// Opens Settings at `section`. A mode's section shows that mode underneath, which draws it.
    pub fn open_settings(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        let mode = match section {
            SettingsSection::Mode(mode) => mode,
            SettingsSection::General => self.mode,
        };
        if self.settings != Some(section) || self.mode != mode {
            self.settings = Some(section);
            self.mode = mode;
            cx.notify();
        }
    }

    pub fn close_settings(&mut self, cx: &mut Context<Self>) {
        if self.settings.take().is_some() {
            cx.notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_work_as_the_switcher_does() {
        assert_eq!(
            ModeActivity::Progress(0.404).describe(ModeId::Tidy),
            "Tidy · 40% done"
        );
        assert_eq!(
            ModeActivity::Working.describe(ModeId::View),
            "View · working"
        );
        assert_eq!(ModeActivity::Progress(1.7).percent(), 100);
    }

    #[test]
    fn mode_keys_round_trip() {
        for mode in ModeId::ALL {
            assert_eq!(ModeId::from_key(mode.key()), Some(mode));
        }
        assert_eq!(ModeId::from_key("frame-view"), None);
    }
}
