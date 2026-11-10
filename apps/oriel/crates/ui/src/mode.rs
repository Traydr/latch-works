//! What the shell asks of every mode, and what a mode offers it: one interface, so the shell
//! loops over the modes and names them only where it makes them.
//!
//! A mode implements [`Mode`]. The shell holds each as an [`AnyMode`] in a [`ModeMap`], draws the
//! one on screen, hands it the keys, gathers the folders each works on, builds the menu bar, the
//! key bindings and the shortcut sheet from each mode's [`Command`]s, and passes on what one mode
//! hands another ([`crate::HandOffRequest`]).

use std::any::Any;
use std::ops::{Index, IndexMut};
use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::{
    Action, AnyElement, AnyView, App, Bounds, Context, Entity, FocusHandle, Focusable, KeyContext,
    Pixels, Render, SharedString, Subscription, Task, Window, px,
};

use crate::folders::HandOff;
use crate::shell::ModeId;
use crate::shortcuts::Sheet;

/// One `T` for each mode.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModeMap<T>([T; 3]);

impl<T> ModeMap<T> {
    /// Each mode's `T`, made in the switcher's order.
    pub fn from_fn(mut make: impl FnMut(ModeId) -> T) -> Self {
        Self(ModeId::ALL.map(&mut make))
    }

    /// Each mode with its `T`, in the switcher's order.
    pub fn iter(&self) -> impl Iterator<Item = (ModeId, &T)> {
        ModeId::ALL.into_iter().zip(&self.0)
    }

    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.0.iter()
    }
}

fn slot(mode: ModeId) -> usize {
    ModeId::ALL
        .iter()
        .position(|each| *each == mode)
        .expect("every mode is in ModeId::ALL")
}

impl<T> Index<ModeId> for ModeMap<T> {
    type Output = T;

    fn index(&self, mode: ModeId) -> &T {
        &self.0[slot(mode)]
    }
}

impl<T> IndexMut<ModeId> for ModeMap<T> {
    fn index_mut(&mut self, mode: ModeId) -> &mut T {
        &mut self.0[slot(mode)]
    }
}

/// What a mode keeps at the window's foot, which the activity indicator and toasts stand on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Foot {
    pub height: Pixels,
    /// Room the page keeps free among its commands, where a toast covers nothing.
    pub toast_slot: Option<Bounds<Pixels>>,
    /// Room the page keeps free among its commands for the activity indicator.
    pub activity_room: Option<Bounds<Pixels>>,
}

impl Foot {
    pub fn height(height: Pixels) -> Self {
        Self {
            height,
            ..Self::default()
        }
    }
}

impl Default for Foot {
    fn default() -> Self {
        Self {
            height: px(0.),
            toast_slot: None,
            activity_room: None,
        }
    }
}

/// The first start's welcome sets one folder up for every mode, as the owner chose: View opens it,
/// Tidy tidies it if asked, Sync pushes it to a server if one was given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderSetUp {
    pub folder: PathBuf,
    pub tidy: bool,
    pub server: Option<PaneServer>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneServer {
    pub api_url: String,
    pub token: Option<String>,
}

/// Where a command sits in the menu bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuSlot {
    /// At the top of File.
    File,
    /// In place of Edit › Undo.
    Undo,
    /// In place of Edit › Select All.
    SelectAll,
    /// At the end of Edit.
    Edit,
    /// After the modes in View.
    View,
}

/// One thing a mode can be told to do: its action, where the menu bar shows it, its keys (bound
/// while the mode is on screen, and shown wherever the command is), and its line in the shortcut
/// sheet.
pub struct Command {
    pub action: Box<dyn Action>,
    pub menu: Option<(MenuSlot, SharedString)>,
    /// A GPUI keystroke, such as `cmd-o`; [`crate::keys::display`] shows it.
    pub keys: Option<&'static str>,
    /// Its line in the sheet's first group.
    pub sheet: Option<SharedString>,
}

impl Command {
    pub fn new(action: impl Action) -> Self {
        Self {
            action: Box::new(action),
            menu: None,
            keys: None,
            sheet: None,
        }
    }

    pub fn menu(mut self, slot: MenuSlot, label: impl Into<SharedString>) -> Self {
        self.menu = Some((slot, label.into()));
        self
    }

    pub fn keys(mut self, keys: &'static str) -> Self {
        self.keys = Some(keys);
        self
    }

    pub fn sheet(mut self, label: impl Into<SharedString>) -> Self {
        self.sheet = Some(label.into());
        self
    }
}

/// The key context the shell's root element sets: `Shell`, with the mode on screen as
/// `mode = view`, `tidy` or `sync`.
pub fn shell_key_context(mode: ModeId) -> KeyContext {
    let mut context = KeyContext::default();
    context.add("Shell");
    context.set("mode", mode.key());
    context
}

/// The context a mode's command keys are bound in: only while that mode is on screen, so ⌘O is
/// Open Folder… in View and Add Folder… in Tidy.
pub fn mode_key_context(mode: ModeId) -> String {
    format!("Shell && mode == {}", mode.key())
}

/// A mode of the window.
pub trait Mode: Render + Focusable {
    const ID: ModeId;

    /// What the mode can be told to do from the menu bar and its keys.
    fn commands() -> Vec<Command>;

    /// Its shortcut sheet, under the keys every mode shares and its commands'.
    fn sheet() -> Sheet;

    /// The folders it works on, for the other modes to offer.
    fn folders(&self, cx: &App) -> Vec<PathBuf>;

    fn foot(&self, cx: &App) -> Foot;

    /// Its section of the one Settings page.
    fn settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement;

    /// Shows what another mode handed it. A mode that takes it comes on screen.
    fn show_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>);

    /// Sets the welcome's folder up, saying why when it cannot.
    fn set_up(
        &mut self,
        set_up: &FolderSetUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>>;
}

trait ErasedMode {
    fn as_any(&self) -> &dyn Any;
    fn id(&self) -> ModeId;
    fn view(&self) -> AnyView;
    fn focus_handle(&self, cx: &App) -> FocusHandle;
    fn commands(&self) -> Vec<Command>;
    fn sheet(&self) -> Sheet;
    fn folders(&self, cx: &App) -> Vec<PathBuf>;
    fn foot(&self, cx: &App) -> Foot;
    fn settings_section(&self, window: &mut Window, cx: &mut App) -> AnyElement;
    fn show_hand_off(&self, target: HandOff, window: &mut Window, cx: &mut App);
    fn set_up(
        &self,
        set_up: &FolderSetUp,
        window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<(), SharedString>>;
    fn observe(&self, on_change: Box<dyn Fn(&mut App)>, cx: &mut App) -> Subscription;
}

impl<M: Mode> ErasedMode for Entity<M> {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn id(&self) -> ModeId {
        M::ID
    }

    fn view(&self) -> AnyView {
        self.clone().into()
    }

    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.read(cx).focus_handle(cx)
    }

    fn commands(&self) -> Vec<Command> {
        M::commands()
    }

    fn sheet(&self) -> Sheet {
        M::sheet()
    }

    fn folders(&self, cx: &App) -> Vec<PathBuf> {
        self.read(cx).folders(cx)
    }

    fn foot(&self, cx: &App) -> Foot {
        self.read(cx).foot(cx)
    }

    fn settings_section(&self, window: &mut Window, cx: &mut App) -> AnyElement {
        self.update(cx, |mode, cx| mode.settings_section(window, cx))
    }

    fn show_hand_off(&self, target: HandOff, window: &mut Window, cx: &mut App) {
        self.update(cx, |mode, cx| mode.show_hand_off(target, window, cx));
    }

    fn set_up(
        &self,
        set_up: &FolderSetUp,
        window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<(), SharedString>> {
        self.update(cx, |mode, cx| mode.set_up(set_up, window, cx))
    }

    fn observe(&self, on_change: Box<dyn Fn(&mut App)>, cx: &mut App) -> Subscription {
        cx.observe(self, move |_, cx| on_change(cx))
    }
}

/// A mode, whichever it is.
#[derive(Clone)]
pub struct AnyMode(Rc<dyn ErasedMode>);

impl<M: Mode> From<Entity<M>> for AnyMode {
    fn from(entity: Entity<M>) -> Self {
        Self(Rc::new(entity))
    }
}

impl AnyMode {
    pub fn id(&self) -> ModeId {
        self.0.id()
    }

    /// The mode as the concrete `M` it is, if it is one.
    pub fn downcast<M: Mode>(&self) -> Option<&Entity<M>> {
        self.0.as_any().downcast_ref()
    }

    pub fn view(&self) -> AnyView {
        self.0.view()
    }

    /// Where the keys go as the mode comes on screen with none of its own kept.
    pub fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.0.focus_handle(cx)
    }

    pub fn commands(&self) -> Vec<Command> {
        self.0.commands()
    }

    pub fn sheet(&self) -> Sheet {
        self.0.sheet()
    }

    pub fn folders(&self, cx: &App) -> Vec<PathBuf> {
        self.0.folders(cx)
    }

    pub fn foot(&self, cx: &App) -> Foot {
        self.0.foot(cx)
    }

    pub fn settings_section(&self, window: &mut Window, cx: &mut App) -> AnyElement {
        self.0.settings_section(window, cx)
    }

    pub fn show_hand_off(&self, target: HandOff, window: &mut Window, cx: &mut App) {
        self.0.show_hand_off(target, window, cx);
    }

    pub fn set_up(
        &self,
        set_up: &FolderSetUp,
        window: &mut Window,
        cx: &mut App,
    ) -> Task<Result<(), SharedString>> {
        self.0.set_up(set_up, window, cx)
    }

    /// Calls `on_change` whenever the mode notifies.
    pub fn observe(&self, on_change: impl Fn(&mut App) + 'static, cx: &mut App) -> Subscription {
        self.0.observe(Box::new(on_change), cx)
    }
}
