//! The welcome on the owner's first start, over the whole window: one archive folder for View,
//! which opens it, and for Tidy, which tidies it if asked, with a Pane View server for Sync when
//! Sync has no profile yet. Every step can be skipped; it lands in View, and shows once: a
//! `welcomed` file in the shell's folder says so.
//!
//! In a sandboxed run (`ORIEL_DATA_DIR`) Tidy takes only folders in its sandbox, so for a
//! folder outside it "Tidy it" is off and says why.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, Render, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_paths::DataRoot;
use oriel_ui::TextRole as _;
use oriel_ui::{AnyMode, ControlSize as _, FolderSetUp, ModeId, ModeMap, PaneServer, ShellState};

/// Whether this run may show the welcome: always on the owner's own data, and under a sandboxed
/// data folder (a check, a test) only when the launch asks (`ORIEL_WELCOME=1`).
pub fn allowed(data: &DataRoot, asked: bool) -> bool {
    !data.is_sandboxed() || asked
}

/// Whether the owner has been through the welcome (`welcomed`).
pub fn welcomed(data: &DataRoot) -> bool {
    data.welcomed().exists()
}

/// Notes that the welcome has been seen: the time, as Electron Oriel wrote it.
pub fn mark_welcomed(data: &DataRoot) {
    let file = data.welcomed();
    let stamp = format!(
        "{}\n",
        oriel_core_domain::format::iso_timestamp(SystemTime::now())
    );
    if let Err(error) = std::fs::write(&file, stamp) {
        log::warn!("Oriel could not note the welcome as seen: {error}");
    }
}

/// The welcome is done, by Start or Skip; the shell closes it and shows View.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WelcomeEvent {
    Finished,
}

pub struct Welcome {
    shell: Entity<ShellState>,
    data: DataRoot,
    modes: ModeMap<AnyMode>,
    /// Sync has no profile, so the welcome offers to connect Pane View.
    needs_server: bool,
    folder: Option<PathBuf>,
    tidy_it: bool,
    sync_it: bool,
    api_url: Entity<InputState>,
    token: Entity<InputState>,
    busy: bool,
    problems: Vec<SharedString>,
}

impl EventEmitter<WelcomeEvent> for Welcome {}

impl Welcome {
    pub fn new(
        shell: &Entity<ShellState>,
        data: DataRoot,
        modes: ModeMap<AnyMode>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let needs_server = modes[ModeId::Sync].folders(cx).is_empty();
        let api_url =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://pane.example.com"));
        let placeholder = format!(
            "Sync API token, saved encrypted in {}",
            data.root().display()
        );
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(placeholder)
                .masked(true)
        });
        Self {
            shell: shell.clone(),
            data,
            modes,
            needs_server,
            folder: None,
            tidy_it: true,
            sync_it: false,
            api_url,
            token,
            busy: false,
            problems: Vec::new(),
        }
    }

    /// The folder chosen, once one is.
    pub fn folder(&self) -> Option<&Path> {
        self.folder.as_deref()
    }

    /// Whether Start also has Tidy tidy the folder: asked for, and allowed by the sandbox.
    pub fn tidies(&self) -> bool {
        self.tidy_it
            && self
                .folder
                .as_deref()
                .is_some_and(|folder| self.admits(folder))
    }

    /// What Start ran into, one line each, until it is pressed again.
    pub fn problems(&self) -> &[SharedString] {
        &self.problems
    }

    fn admits(&self, folder: &Path) -> bool {
        self.data.admits_tidy_root(folder)
    }

    /// No folder any mode uses is there, so the welcome asks for one. Once one is chosen the
    /// question stays, though View then knows the folder.
    fn needs_folder(&self, cx: &App) -> bool {
        self.folder.is_some() || self.shell.read(cx).known_folders().is_empty()
    }

    /// Asks for the folder with the system's picker.
    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.folder = Some(folder);
                this.problems.clear();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Sets the folder up in every mode, as the owner chose. Anything that fails is listed, and
    /// Start reads Continue; otherwise the welcome is done.
    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(folder) = self.folder.clone().filter(|_| self.problems.is_empty()) else {
            cx.emit(WelcomeEvent::Finished);
            return;
        };
        self.busy = true;
        cx.notify();

        let api_url = self.api_url.read(cx).value().trim().to_owned();
        let token = self.token.read(cx).value().trim().to_owned();
        let server =
            (self.sync_it && self.needs_server && !api_url.is_empty()).then(|| PaneServer {
                api_url,
                token: Some(token).filter(|token| !token.is_empty()),
            });
        let set_up = FolderSetUp {
            tidy: self.tidies(),
            folder,
            server,
        };
        let setting_up: Vec<_> = self
            .modes
            .values()
            .map(|mode| (mode.id(), mode.set_up(&set_up, window, cx)))
            .collect();
        cx.spawn_in(window, async move |this, cx| {
            let mut problems: Vec<SharedString> = Vec::new();
            for (mode, task) in setting_up {
                if let Err(problem) = task.await {
                    problems.push(format!("{}: {problem}", mode.label()).into());
                }
            }
            this.update(cx, |this, cx| {
                this.busy = false;
                if problems.is_empty() {
                    cx.emit(WelcomeEvent::Finished);
                } else {
                    this.problems = problems;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The three modes' icons side by side.
    fn render_mark(&self, cx: &App) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_row()
            .justify_center()
            .gap_3()
            .children(ModeId::ALL.map(|mode| {
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(48.))
                    .rounded(theme.radius_lg)
                    .bg(theme.muted)
                    .child(
                        Icon::new(mode.icon())
                            .size(px(24.))
                            .text_color(theme.primary),
                    )
            }))
    }

    fn render_folder(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let chosen = self.folder.clone();
        let row = |id: &'static str| {
            div()
                .id(id)
                .flex()
                .flex_row()
                .items_center()
                .gap_4()
                .min_h(px(56.))
                .px_4()
                .py(px(10.))
        };
        let text = |title: &'static str, caption: SharedString| {
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .text_body()
                .child(title)
                .child(
                    div()
                        .text_caption()
                        .text_color(theme.muted_foreground)
                        .child(caption),
                )
        };
        let mut card = div()
            .mt_3()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.group_box)
            .border_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .min_h(px(60.))
                    .px_4()
                    .py(px(10.))
                    .child(
                        Icon::new(IconName::FolderOpen)
                            .size(px(20.))
                            .flex_shrink_0()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .id("welcome-folder-name")
                                    .test_support()
                                    .truncate()
                                    .text_body()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(
                                        chosen
                                            .as_deref()
                                            .map_or("No folder yet".into(), folder_name),
                                    ),
                            )
                            .when_some(chosen.clone(), |this, folder| {
                                let path = SharedString::from(folder.display().to_string());
                                this.child(
                                    div()
                                        .id("welcome-folder-path")
                                        .test_support()
                                        .aria_label(path.clone())
                                        .truncate()
                                        .text_caption()
                                        .text_color(theme.muted_foreground)
                                        .child(path),
                                )
                            }),
                    )
                    .child(
                        Button::new("welcome-choose-folder")
                            .bar_size()
                            .outline()
                            .quiet_edge(cx)
                            .label(if chosen.is_some() {
                                "Change…"
                            } else {
                                "Choose folder…"
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
                    ),
            );
        let Some(folder) = chosen else {
            return card.into_any_element();
        };
        let admitted = self.admits(&folder);
        let tidy_caption: SharedString = if admitted {
            "Find duplicates, formats to convert and junk.".into()
        } else {
            oriel_mode_tidy::links::sandbox_rule(&self.data).into()
        };
        card = card.child(
            row("welcome-tidy-row")
                .border_t_1()
                .border_color(theme.border)
                .child(text("Tidy it", tidy_caption))
                .child(
                    oriel_ui::switch("welcome-tidy-it")
                        .accessibility_label("Tidy it")
                        .checked(self.tidies())
                        .disabled(!admitted)
                        .on_click(cx.listener(|this, checked: &bool, _, cx| {
                            this.tidy_it = *checked;
                            cx.notify();
                        })),
                ),
        );
        if self.needs_server {
            card = card.child(
                div()
                    .flex()
                    .flex_col()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(
                        row("welcome-sync-row")
                            .child(text(
                                "Sync it to Pane View",
                                "Push it to your Pane View server.".into(),
                            ))
                            .child(
                                oriel_ui::switch("welcome-sync-it")
                                    .accessibility_label("Sync it to Pane View")
                                    .checked(self.sync_it)
                                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                        this.sync_it = *checked;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .when(self.sync_it, |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .px_4()
                                .pb_3()
                                .child(
                                    Input::new(&self.api_url)
                                        .bar_size()
                                        .aria_label("Pane View API URL"),
                                )
                                .child(
                                    Input::new(&self.token)
                                        .bar_size()
                                        .aria_label("Sync API token"),
                                ),
                        )
                    }),
            );
        }
        card.into_any_element()
    }
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.display().to_string())
}

impl Render for Welcome {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let needs_folder = self.needs_folder(cx);
        let folder = needs_folder.then(|| self.render_folder(cx));
        let theme = cx.theme();
        let start_label = if !self.problems.is_empty() {
            "Continue"
        } else if self.busy {
            "Setting up…"
        } else {
            "Start"
        };
        div()
            .id("welcome")
            .test_support()
            .role(Role::Region)
            .aria_label("Welcome to Oriel")
            .flex()
            .flex_col()
            .p_4()
            .text_color(theme.foreground)
            .child(self.render_mark(cx))
            .child(
                div()
                    .mt_6()
                    .text_center()
                    .text_2xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Welcome to Oriel"),
            )
            .child(
                div()
                    .mt_2()
                    .text_center()
                    .text_body()
                    .text_color(theme.muted_foreground)
                    .child("View, tidy and sync your archive, in one window."),
            )
            .when_some(folder, |this, folder| {
                this.child(
                    div()
                        .mt_6()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_heading()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Choose your archive folder"),
                        )
                        .child(
                            div()
                                .mt_0p5()
                                .text_caption()
                                .text_color(theme.muted_foreground)
                                .child(
                                    "View opens it now; Tidy and Sync can take it too. Nothing \
                                     in it changes until you ask.",
                                ),
                        )
                        .child(folder),
                )
            })
            .when(!self.problems.is_empty(), |this| {
                this.child(
                    div()
                        .id("welcome-problems")
                        .test_support()
                        .role(Role::Alert)
                        .aria_label(SharedString::from(self.problems.join("\n")))
                        .mt_4()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .text_body()
                        .text_color(theme.danger)
                        .children(self.problems.iter().cloned()),
                )
            })
            .child(
                div()
                    .mt_8()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap_2()
                    .when(self.folder.is_none() && needs_folder, |this| {
                        this.child(
                            Button::new("welcome-skip")
                                .ghost()
                                .page_size()
                                .label("Skip")
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(WelcomeEvent::Finished);
                                })),
                        )
                    })
                    .child(
                        Button::new("welcome-start")
                            .page_size()
                            .primary()
                            .label(start_label)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.start(window, cx))),
                    ),
            )
    }
}
