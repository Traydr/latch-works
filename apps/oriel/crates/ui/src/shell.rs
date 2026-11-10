//! What every mode's window shares: which mode shows, whether the sidebar is the rail, the work
//! each mode reports, which section of Settings is open, the folders the modes work on, and what
//! one mode hands another.

use gpui_kit::assets::IconName;
use gpui_kit::{App, AppContext as _, Context, Entity, EventEmitter, Subscription, Window};

use crate::activity::{Activity, ActivityJob, JobCommand};
use crate::folders::{HandOff, KnownFolder};
use crate::mode::ModeMap;

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

    /// The keys that show the mode.
    pub fn keys(self) -> &'static str {
        match self {
            ModeId::View => crate::cmd_or_ctrl!("1"),
            ModeId::Tidy => crate::cmd_or_ctrl!("2"),
            ModeId::Sync => crate::cmd_or_ctrl!("3"),
        }
    }
}

/// How a mode's work shows on its switcher button while another mode is on screen (plan 059): a
/// ring for work with a known end, a dot for work without one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ModeActivity {
    Working,
    /// `0.0..=1.0` done; the Dock shows it too.
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

/// What a mode reports it is doing. Report `Work::default()` when it is idle.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Work {
    /// How the switcher shows it.
    pub shown: Option<ModeActivity>,
    /// Whether quitting waits for it: work that changes files or the server, and can finish.
    pub holds_quit: bool,
    /// Its rows in the activity panel.
    pub jobs: Vec<ActivityJob>,
}

/// One mode's line to the shell's switcher and activity panel.
#[derive(Clone)]
pub struct ModeReporter {
    shell: Entity<ShellState>,
    mode: ModeId,
}

impl ModeReporter {
    pub fn new(shell: &Entity<ShellState>, mode: ModeId) -> Self {
        Self {
            shell: shell.clone(),
            mode,
        }
    }

    /// Reports the mode's work as it is now, in one call so the switcher and the panel agree.
    pub fn report(&self, work: Work, cx: &mut App) {
        let Work {
            shown,
            holds_quit,
            jobs,
        } = work;
        let mode = self.mode;
        let board = self.shell.read(cx).jobs.clone();
        self.shell
            .update(cx, |shell, cx| shell.set_work(mode, shown, holds_quit, cx));
        board.update(cx, |board, cx| board.set_jobs(mode, jobs, cx));
    }

    /// Calls `on_command` with each Pause, Resume and Stop pressed in the panel on one of this
    /// mode's jobs.
    pub fn on_command<T: 'static>(
        &self,
        window: &mut Window,
        cx: &mut Context<T>,
        mut on_command: impl FnMut(&mut T, &JobCommand, &mut Window, &mut Context<T>) + 'static,
    ) -> Subscription {
        let mode = self.mode;
        let board = self.shell.read(cx).jobs.clone();
        cx.subscribe_in(
            &board,
            window,
            move |this, _, command: &JobCommand, window, cx| {
                if command.mode() == mode {
                    on_command(this, command, window, cx);
                }
            },
        )
    }
}

/// What a mode asks of the shell: show mode `to` with `target`, as Open in View, Show in Tidy and
/// Sync this folder do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandOffRequest {
    pub to: ModeId,
    pub target: HandOff,
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

/// A window narrower than this shows the sidebar as the rail, unless the owner expands it.
pub const NARROW_WINDOW: f32 = 1120.;

/// The shell's state, one per window. Modes observe it; a hidden mode's own state simply lives
/// on in its entity.
pub struct ShellState {
    mode: ModeId,
    /// The owner's choice of sidebar, which is what is remembered.
    rail: bool,
    /// Whether the window is too narrow to give a full sidebar its width, and whether the owner
    /// expanded it all the same.
    narrow_window: bool,
    expanded_while_narrow: bool,
    activity: ModeMap<Option<ModeActivity>>,
    holds_quit: ModeMap<bool>,
    jobs: Entity<Activity>,
    settings: Option<SettingsSection>,
    folders: Vec<KnownFolder>,
}

impl EventEmitter<HandOffRequest> for ShellState {}

impl ShellState {
    pub fn new(mode: ModeId, rail: bool, cx: &mut Context<Self>) -> Self {
        Self {
            mode,
            rail,
            narrow_window: false,
            expanded_while_narrow: false,
            activity: ModeMap::default(),
            holds_quit: ModeMap::default(),
            jobs: cx.new(|_| Activity::default()),
            settings: None,
            folders: Vec::new(),
        }
    }

    /// Every mode's jobs, running and queued, which the shell draws at the window's bottom
    /// right; each mode reports its own through its [`ModeReporter`].
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

    /// How `mode`'s work shows, if it reports any.
    pub fn activity(&self, mode: ModeId) -> Option<ModeActivity> {
        self.activity[mode]
    }

    fn set_work(
        &mut self,
        mode: ModeId,
        shown: Option<ModeActivity>,
        holds_quit: bool,
        cx: &mut Context<Self>,
    ) {
        let changed = ModeActivity::shown(self.activity[mode]) != ModeActivity::shown(shown)
            || self.holds_quit[mode] != holds_quit;
        self.activity[mode] = shown;
        self.holds_quit[mode] = holds_quit;
        if changed {
            cx.notify();
        }
    }

    /// Whether a mode runs work that quitting must wait for.
    pub fn holds_quit(&self) -> bool {
        self.holds_quit.values().any(|holds| *holds)
    }

    /// Whether no mode reports work.
    pub fn is_idle(&self) -> bool {
        self.activity.values().all(Option::is_none) && !self.holds_quit()
    }

    /// The mean of the rings' progress, `0.0..=1.0`, while any mode shows one; the Dock shows it.
    pub fn progress(&self) -> Option<f32> {
        let ratios: Vec<f32> = self
            .activity
            .values()
            .filter_map(|activity| match activity {
                Some(ModeActivity::Progress(ratio)) => Some(ratio.clamp(0., 1.)),
                _ => None,
            })
            .collect();
        (!ratios.is_empty()).then(|| ratios.iter().sum::<f32>() / ratios.len() as f32)
    }

    /// Whether `mode` is on screen, with no Settings over it.
    pub fn shows(&self, mode: ModeId) -> bool {
        self.mode == mode && self.settings.is_none()
    }

    /// Asks the shell to show mode `to` with `target`.
    pub fn hand_off(&mut self, to: ModeId, target: HandOff, cx: &mut Context<Self>) {
        cx.emit(HandOffRequest { to, target });
    }

    pub fn mode(&self) -> ModeId {
        self.mode
    }

    /// Whether the sidebar is compact, the rail of icons, the same in every mode: the owner's
    /// choice, and always below [`NARROW_WINDOW`] unless they expand it there, since a full sidebar
    /// and Tidy's queue would take half such a window from the pictures.
    pub fn rail(&self) -> bool {
        self.rail || (self.narrow_window && !self.expanded_while_narrow)
    }

    /// The owner's choice of sidebar, whatever the window's width does to it for now.
    pub fn rail_choice(&self) -> bool {
        self.rail
    }

    /// The shell says how wide the window is as it draws.
    pub fn set_window_width(&mut self, width: f32, cx: &mut Context<Self>) {
        let narrow = width < NARROW_WINDOW;
        if narrow != self.narrow_window {
            self.narrow_window = narrow;
            self.expanded_while_narrow = false;
            cx.notify();
        }
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

    /// The sidebar's toggle: in a narrow window it only changes the form for now, and the owner's
    /// choice waits for a wider one.
    pub fn toggle_rail(&mut self, cx: &mut Context<Self>) {
        if self.narrow_window && !self.rail {
            self.expanded_while_narrow = !self.expanded_while_narrow;
        } else {
            self.rail = !self.rail;
        }
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
}
