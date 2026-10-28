//! What every mode's window shares: which mode shows, and whether the sidebar is the rail.

use gpui_kit::Context;
use gpui_kit::assets::IconName;

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
    /// A push or a Tidy change, `0.0..=1.0` done: a ring, and the Dock's progress.
    Progress(f32),
}

/// The shell's state, one per window. Modes observe it; a hidden mode's own state simply lives
/// on in its entity.
pub struct ShellState {
    mode: ModeId,
    rail: bool,
    activity: [Option<ModeActivity>; 3],
}

impl ShellState {
    pub fn new(mode: ModeId, rail: bool) -> Self {
        Self {
            mode,
            rail,
            activity: [None; 3],
        }
    }

    /// What `mode` is doing, if anything.
    pub fn activity(&self, mode: ModeId) -> Option<ModeActivity> {
        self.activity[mode.index()]
    }

    /// Modes report their work here; the shell draws it and keeps the window open for it.
    pub fn set_activity(
        &mut self,
        mode: ModeId,
        activity: Option<ModeActivity>,
        cx: &mut Context<Self>,
    ) {
        if self.activity[mode.index()] != activity {
            self.activity[mode.index()] = activity;
            cx.notify();
        }
    }

    pub fn mode(&self) -> ModeId {
        self.mode
    }

    /// Whether the sidebar is compact, the rail of icons: the owner's choice alone, the same in
    /// every mode and at any window size.
    pub fn rail(&self) -> bool {
        self.rail
    }

    pub fn go(&mut self, mode: ModeId, cx: &mut Context<Self>) {
        if self.mode != mode {
            self.mode = mode;
            cx.notify();
        }
    }

    pub fn toggle_rail(&mut self, cx: &mut Context<Self>) {
        self.rail = !self.rail;
        cx.notify();
    }
}
