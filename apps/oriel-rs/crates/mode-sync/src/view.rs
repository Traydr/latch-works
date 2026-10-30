//! Sync's screens, as Electron Oriel draws them (`ProfileSidebar.tsx`, `SyncPage.tsx`,
//! `PlanWorkspace.tsx`, `PlanTree.tsx`, `RunPanel.tsx`, `ProfileSetupView.tsx`,
//! `SyncSettings.tsx`): the profiles in the sidebar, the plan as the page, the run floating over
//! the plan's lower right and the run log along the bottom.

use std::ops::Range;
use std::time::SystemTime;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _, WindowExt as _,
};
use gpui_kit::{
    AnyElement, App, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px, relative, uniform_list,
};
use oriel_core_domain::format_bytes;
use oriel_core_index::SyncPlanAction;
use oriel_core_sync::{RunAction, format_count, parse_iso_timestamp};
use oriel_ui::layout::NavItem;
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{ModeId, ModeLayout, OfferedFolders, SettingsGroup, SettingsRow, TopBar};

use crate::profiles::{Profile, TokenState};
use crate::run::{self, ItemState, PruneAvailability, RunPhase};
use crate::{FocusPlanFilter, KEY_CONTEXT, RowModel, RunFilter, Screen, SyncMode, ToggleRunLog};

/// A plan row's height, as Electron Oriel's `h-8`.
const ROW_HEIGHT: f32 = 32.;

/// The run panel's width.
const RUN_PANEL_WIDTH: f32 = 300.;

/// Points along the throughput chart.
const CHART_BUCKETS: usize = 48;

/// Opens an alert dialog for a consequential action: the decision as its title, the consequence
/// below, and the action named on its button.
pub(crate) fn confirm(
    sync: &gpui_kit::Entity<SyncMode>,
    window: &mut Window,
    cx: &mut Context<SyncMode>,
    title: String,
    description: &'static str,
    action: &'static str,
    on_confirm: impl Fn(&mut Window, &mut App) + 'static,
) {
    let on_confirm = std::rc::Rc::new(on_confirm);
    let sync = sync.clone();
    window.open_alert_dialog(cx, move |alert, _, _| {
        let on_confirm = on_confirm.clone();
        let (confirmed, closed) = (sync.clone(), sync.clone());
        alert
            .title(title.clone())
            .description(description)
            .confirm()
            .ok_text(action)
            .ok_variant(ButtonVariant::Danger)
            .cancel_text("Cancel")
            .on_ok(move |_, window, cx| {
                confirmed.update(cx, |sync, cx| sync.set_confirmation(None, cx));
                on_confirm(window, cx);
                true
            })
            .on_close(move |_, _, cx| {
                closed.update(cx, |sync, cx| sync.set_confirmation(None, cx));
            })
    });
}

/// How a profile's state reads in the sidebar (`profileStatus`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone {
    Error,
    Warning,
    Ok,
    Neutral,
}

fn tone_color(tone: Tone, cx: &App) -> Hsla {
    let theme = cx.theme();
    match tone {
        Tone::Error => theme.danger,
        Tone::Warning => theme.warning,
        Tone::Ok => theme.success,
        Tone::Neutral => theme.muted_foreground,
    }
}

fn describe_pending(counts: oriel_core_sync::PlanCounts) -> (String, Tone) {
    let pending = counts.changes();
    if pending > 0 {
        (format!("{} to sync", format_count(pending)), Tone::Warning)
    } else {
        ("In sync".to_owned(), Tone::Ok)
    }
}

fn action_name(action: RunAction) -> &'static str {
    match action {
        RunAction::Plan => "Plan",
        RunAction::Push => "Push",
        RunAction::Prune => "Prune",
        RunAction::Doctor => "Connection check",
    }
}

fn profile_status(
    profile: &Profile,
    token: TokenState,
    current: Option<oriel_core_sync::PlanCounts>,
) -> (String, Tone) {
    use oriel_core_sync::RunStatus;
    match token {
        TokenState::Unreadable => return ("Token unreadable".to_owned(), Tone::Error),
        TokenState::None => return ("No token saved".to_owned(), Tone::Warning),
        TokenState::Saved => {}
    }
    if let Some(counts) = current {
        return describe_pending(counts);
    }
    let Some(last) = &profile.last_run else {
        return ("Never planned".to_owned(), Tone::Neutral);
    };
    match last.status {
        RunStatus::Failed => (format!("{} failed", action_name(last.action)), Tone::Error),
        RunStatus::Cancelled => (
            format!("{} cancelled", action_name(last.action)),
            Tone::Neutral,
        ),
        RunStatus::Completed => match last.action {
            RunAction::Plan => last
                .plan_counts
                .map_or(("Planned".to_owned(), Tone::Neutral), describe_pending),
            RunAction::Push => (format!("Pushed {}", format_count(last.pushed)), Tone::Ok),
            RunAction::Prune => (format!("Pruned {}", format_count(last.pushed)), Tone::Ok),
            RunAction::Doctor => ("Connection checked".to_owned(), Tone::Ok),
        },
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// "Last push 18 ok, 0 failed · 2d ago" (`describeLastRun`).
fn describe_last_run(profile: &Profile) -> Option<String> {
    let last = profile.last_run.as_ref()?;
    let ago = parse_iso_timestamp(&last.completed_at)
        .map(|at| run::format_ago(at, now_ms()))
        .unwrap_or_default();
    let detail = match last.action {
        RunAction::Push | RunAction::Prune => format!(
            "{} ok, {} failed",
            format_count(last.pushed),
            format_count(last.failed)
        ),
        _ => last.status.as_str().to_owned(),
    };
    let name = match last.action {
        RunAction::Doctor => "check",
        action => action.as_str(),
    };
    Some(format!("Last {name} {detail} · {ago}"))
}

fn plan_action_label(action: SyncPlanAction) -> &'static str {
    match action {
        SyncPlanAction::Upload => "Upload",
        SyncPlanAction::Update => "Update",
        SyncPlanAction::Delete => "Delete",
        SyncPlanAction::Keep => "Keep",
    }
}

fn plan_action_key(action: SyncPlanAction) -> &'static str {
    match action {
        SyncPlanAction::Upload => "upload",
        SyncPlanAction::Update => "update",
        SyncPlanAction::Delete => "delete",
        SyncPlanAction::Keep => "keep",
    }
}

fn plan_action_color(action: SyncPlanAction, cx: &App) -> Hsla {
    let theme = cx.theme();
    match action {
        SyncPlanAction::Upload => theme.info,
        SyncPlanAction::Update => theme.warning,
        SyncPlanAction::Delete => theme.danger,
        SyncPlanAction::Keep => theme.muted_foreground,
    }
}

fn format_size(size: Option<u64>) -> String {
    match size {
        None | Some(0) => "\u{2014}".to_owned(),
        Some(size) => format_bytes(size as f64),
    }
}

/// A status line tests and VoiceOver read by name.
fn status_text(id: &'static str, text: impl Into<SharedString>) -> impl IntoElement {
    let text = text.into();
    div()
        .id(id)
        .role(Role::Status)
        .test_support()
        .aria_label(text.clone())
        .child(text)
}

impl SyncMode {
    pub(crate) fn render_mode(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let rail = self.shell.read(cx).rail();
        let content = match &self.screen {
            Screen::Form { editing } => self
                .render_form(editing.clone(), window, cx)
                .into_any_element(),
            Screen::Workspace => match self.store.active_profile().cloned() {
                Some(profile) => self
                    .render_workspace(&profile, window, cx)
                    .into_any_element(),
                None => self.render_welcome(cx).into_any_element(),
            },
        };
        let this = cx.entity();
        ModeLayout::new(&self.shell)
            .navigation_label("Profiles")
            .navigation(self.render_profiles(rail, cx))
            .footer(
                NavItem::new("sync-add-profile", IconName::Plus, "Add profile")
                    .rail(rail)
                    .on_click(move |_, window, cx| {
                        this.update(cx, |this, cx| this.start_create_profile(window, cx));
                    }),
            )
            .child(
                div()
                    .id("sync-page")
                    .key_context(KEY_CONTEXT)
                    .track_focus(&self.focus_handle)
                    .on_action(cx.listener(|this, _: &ToggleRunLog, _, cx| this.toggle_run_log(cx)))
                    .on_action(cx.listener(|this, _: &FocusPlanFilter, window, cx| {
                        if this.plan.is_some() {
                            this.filter.update(cx, |input, cx| input.focus(window, cx));
                        }
                    }))
                    .on_key_down(
                        cx.listener(|this, event: &gpui_kit::KeyDownEvent, window, cx| {
                            let keystroke = &event.keystroke;
                            if keystroke.key == "/"
                                && !keystroke.modifiers.modified()
                                && this.plan.is_some()
                                && !window.has_focused_input(cx)
                            {
                                this.filter.update(cx, |input, cx| input.focus(window, cx));
                                cx.stop_propagation();
                            }
                        }),
                    )
                    .relative()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(content)
                    .when(self.shows_run_panel(), |this| {
                        this.child(self.render_run_panel(cx))
                    })
                    .when(self.log_open, |this| this.child(self.render_log(cx))),
            )
    }

    fn render_profiles(&self, rail: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.store.active_profile_id().map(str::to_owned);
        let theme = cx.theme().clone();
        let running = self.run.running;
        let current_counts = self.plan.as_ref().map(|reviewed| reviewed.plan.counts);
        div()
            .flex()
            .flex_col()
            .w_full()
            .when(!rail, |this| {
                this.child(
                    div()
                        .px(px(18.))
                        .pt_3()
                        .pb(px(6.))
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.muted_foreground)
                        .child("Profiles"),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .px_2()
                    .when(rail, |this| this.items_center())
                    .children(self.store.profiles().iter().map(|profile| {
                        let current = active.as_deref() == Some(profile.id.as_str());
                        let (caption, tone) = profile_status(
                            profile,
                            self.store.token_state(&profile.id),
                            current.then_some(current_counts).flatten(),
                        );
                        let caption = if current && running {
                            "Running…".to_owned()
                        } else {
                            caption
                        };
                        let id = profile.id.clone();
                        let dot = div()
                            .size(px(8.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(tone_color(tone, cx));
                        let initial = profile
                            .name
                            .trim()
                            .chars()
                            .next()
                            .map(|initial| initial.to_uppercase().to_string())
                            .unwrap_or_else(|| "?".to_owned());
                        gpui_kit::base::Button::new(SharedString::from(format!(
                            "sync-profile-{}",
                            profile.id
                        )))
                        // A press leaves focus where it was, as the sidebar's other items do.
                        .on_mouse_down(gpui_kit::MouseButton::Left, |_, window, _| {
                            window.prevent_default();
                        })
                        .accessibility_label(profile.name.clone())
                        .aria_selected(current)
                        .disabled(running && !current)
                        .relative()
                        .flex_row()
                        .items_center()
                        .flex_shrink_0()
                        .rounded(theme.radius)
                        .gap(px(10.))
                        .text_size(px(13.))
                        .border_2()
                        .border_color(theme.transparent)
                        .map(|this| {
                            if rail {
                                this.size(px(48.)).justify_center()
                            } else {
                                this.w_full().min_h(px(32.)).py(px(6.)).px(px(8.))
                            }
                        })
                        .text_color(if current {
                            theme.foreground
                        } else {
                            theme.sidebar_foreground
                        })
                        .hover(|style| style.bg(theme.accent))
                        .focus_visible(|style| style.border_color(theme.ring))
                        .when(current, |this| {
                            this.bg(theme.sidebar_accent)
                                .font_weight(FontWeight::MEDIUM)
                        })
                        .map(|this| {
                            if rail {
                                this.child(
                                    div()
                                        .size(px(28.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(theme.radius)
                                        .bg(theme.background)
                                        .border_1()
                                        .border_color(theme.border)
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(initial),
                                )
                                .child(div().absolute().top(px(6.)).right(px(6.)).child(dot))
                                .tooltip({
                                    let tip =
                                        SharedString::from(format!("{} · {caption}", profile.name));
                                    move |window, cx| {
                                        gpui_kit::component::tooltip::Tooltip::new(tip.clone())
                                            .build(window, cx)
                                    }
                                })
                            } else {
                                this.child(dot)
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .flex_1()
                                            .min_w_0()
                                            .child(div().truncate().child(profile.name.clone()))
                                            .child(
                                                div()
                                                    .truncate()
                                                    .text_xs()
                                                    .font_weight(FontWeight::NORMAL)
                                                    .text_color(theme.muted_foreground)
                                                    .child(caption),
                                            ),
                                    )
                                    .when(current && running, |this| {
                                        this.child(Spinner::new().small())
                                    })
                            }
                        })
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.select_profile(&id, window, cx);
                            },
                        ))
                    })),
            )
    }

    fn error_banner(&self) -> Option<impl IntoElement> {
        let error = self.error.clone()?;
        Some(
            div()
                .id("sync-error")
                .role(Role::Alert)
                .test_support()
                .aria_label(error.clone())
                .flex_shrink_0()
                .px_5()
                .pt_3()
                .child(gpui_kit::component::alert::Alert::error(
                    "sync-error-alert",
                    error,
                )),
        )
    }

    fn render_welcome(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(TopBar::new(&self.shell, "Sync"))
            .children(self.error_banner())
            .child(
                div()
                    .flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .p_10()
                    .pb(px(100.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .w(px(480.))
                            .max_w_full()
                            .gap_2()
                            .child(
                                Icon::new(IconName::RefreshCw)
                                    .size(px(48.))
                                    .text_color(theme.primary),
                            )
                            .child(
                                div()
                                    .mt_2()
                                    .text_xl()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Sync a folder to Pane View"),
                            )
                            .child(
                                div()
                                    .max_w(px(380.))
                                    .text_sm()
                                    .text_center()
                                    .text_color(theme.muted_foreground)
                                    .child(
                                        "A profile pairs a local archive folder with a Pane View \
                                         server. Plan compares the two, and nothing changes on \
                                         the server until you push.",
                                    ),
                            )
                            .child(
                                div().mt_4().child(
                                    Button::new("sync-welcome-add")
                                        .primary()
                                        .large()
                                        .label("Add a profile")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.start_create_profile(window, cx);
                                        })),
                                ),
                            )
                            .child(
                                OfferedFolders::new(
                                    "sync-offered-folders",
                                    self.shell.read(cx).offered_to(ModeId::Sync),
                                )
                                .title("Or sync one you already use")
                                .on_choose({
                                    let this = cx.entity();
                                    move |folder, window, cx| {
                                        let folder = folder.path().to_path_buf();
                                        this.update(cx, |this, cx| {
                                            this.start_create_profile_for(folder, window, cx);
                                        });
                                    }
                                }),
                            ),
                    ),
            )
    }

    fn render_form(
        &self,
        editing: Option<String>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let editing = editing.and_then(|id| self.store.profile(&id).cloned());
        let token_state = editing.as_ref().map_or(TokenState::None, |profile| {
            self.store.token_state(&profile.id)
        });
        let has_saved_token = token_state != TokenState::None;
        let field = |label: &'static str, control: AnyElement| {
            div()
                .flex()
                .flex_col()
                .gap_1p5()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(label),
                )
                .child(control)
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(TopBar::new(
                &self.shell,
                if editing.is_some() {
                    "Edit profile"
                } else {
                    "New profile"
                },
            ))
            .children(self.error_banner())
            .child(
                div()
                    .id("sync-form-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .mx_auto()
                            .w_full()
                            .max_w(px(560.))
                            .px_6()
                            .pt_6()
                            .pb_16()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .child(
                                div()
                                    .px_1()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(if editing.is_some() {
                                        "Changing the source folder or the API URL clears this \
                                         profile's plan and last run."
                                    } else {
                                        "A profile pairs a local archive folder with a Pane View \
                                         server. Name one for each target, such as your own \
                                         machine and production."
                                    }),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_4()
                                    .p_5()
                                    .rounded(theme.radius_lg)
                                    .bg(theme.group_box)
                                    .border_1()
                                    .border_color(theme.border)
                                    .child(
                                        div()
                                            .flex()
                                            .flex_row()
                                            .gap_4()
                                            .child(field(
                                                "Profile name",
                                                Input::new(&self.form.name)
                                                    .id("profile-name")
                                                    .aria_label("Profile name")
                                                    .into_any_element(),
                                            ))
                                            .child(field(
                                                "Pane View API URL",
                                                Input::new(&self.form.api_url)
                                                    .id("profile-api-url")
                                                    .aria_label("Pane View API URL")
                                                    .into_any_element(),
                                            )),
                                    )
                                    .child(field(
                                        "Source folder",
                                        div()
                                            .flex()
                                            .flex_row()
                                            .gap_2()
                                            .child(
                                                div().flex_1().min_w_0().child(
                                                    Input::new(&self.form.source_root)
                                                        .id("profile-source-root")
                                                        .aria_label("Source folder"),
                                                ),
                                            )
                                            .child(
                                                Button::new("profile-choose-folder")
                                                    .icon(IconName::FolderOpen)
                                                    .label("Choose…")
                                                    .on_click(cx.listener(
                                                        |this, _, window, cx| {
                                                            this.pick_source_folder(window, cx);
                                                        },
                                                    )),
                                            )
                                            .into_any_element(),
                                    ))
                                    .child(field(
                                        "Sync API token",
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap_1p5()
                                            .child(
                                                Input::new(&self.form.token)
                                                    .id("profile-token")
                                                    .aria_label("Sync API token")
                                                    .disabled(self.form.clear_token),
                                            )
                                            .when(token_state == TokenState::Unreadable, |this| {
                                                this.child(
                                                    div()
                                                        .text_xs()
                                                        .text_color(theme.muted_foreground)
                                                        .child(
                                                            "The saved token could not be \
                                                             unlocked. Enter it again to \
                                                             replace it.",
                                                        ),
                                                )
                                            })
                                            .when(has_saved_token, |this| {
                                                this.child(
                                                    Checkbox::new("profile-clear-token")
                                                        .checked(self.form.clear_token)
                                                        .label("Forget the saved token")
                                                        .on_click(cx.listener(
                                                            |this, checked: &bool, window, cx| {
                                                                this.set_clear_token(
                                                                    *checked, window, cx,
                                                                );
                                                            },
                                                        )),
                                                )
                                            })
                                            .into_any_element(),
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .justify_end()
                                    .gap_2()
                                    .child(Button::new("profile-cancel").label("Cancel").on_click(
                                        cx.listener(|this, _, window, cx| {
                                            this.cancel_profile_form(window, cx);
                                        }),
                                    ))
                                    .child(
                                        Button::new("profile-save")
                                            .primary()
                                            .label(if editing.is_some() {
                                                "Save changes"
                                            } else {
                                                "Save profile"
                                            })
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.submit_profile(window, cx);
                                            })),
                                    ),
                            ),
                    ),
            )
    }

    fn render_workspace(
        &self,
        profile: &Profile,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let meta = match &self.plan {
            Some(reviewed) => {
                let planned = reviewed
                    .planned_at
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map_or(0, |since| since.as_millis() as i64);
                format!(
                    "Planned {} · {} files · {}",
                    run::format_ago(planned, now_ms()),
                    format_count(reviewed.plan.total_files),
                    format_bytes(reviewed.plan.total_bytes as f64)
                )
            }
            None => describe_last_run(profile).unwrap_or_default(),
        };
        let token_state = self.store.token_state(&profile.id);
        let bar = TopBar::new(&self.shell, profile.name.clone())
            .trailing(
                div()
                    .max_w(px(320.))
                    .truncate()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(meta),
            )
            .trailing(self.render_profile_menu(profile, cx));
        let bar = match &self.plan {
            Some(_) => bar.trailing(self.render_plan_actions(cx)),
            None => bar,
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(bar)
            .children(self.error_banner())
            .child(match &self.plan {
                Some(_) => self.render_plan(profile, cx).into_any_element(),
                None => self.render_no_plan(profile, cx).into_any_element(),
            })
            .when(
                token_state != TokenState::Saved || self.doctor_result.is_some(),
                |this| {
                    this.child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_shrink_0()
                            .gap_4()
                            .px_5()
                            .py_4()
                            .border_t_1()
                            .border_color(theme.border)
                            .when(token_state != TokenState::Saved, |this| {
                                this.child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap_1p5()
                                        .max_w(px(448.))
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .child("Sync API token"),
                                        )
                                        .child(
                                            Input::new(&self.session_token)
                                                .id("session-token")
                                                .aria_label("Sync API token"),
                                        )
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(theme.muted_foreground)
                                                .child(if token_state == TokenState::Unreadable {
                                                    "The saved token could not be unlocked. \
                                                     Enter it again to replace it."
                                                } else {
                                                    "Encrypted with a key kept in \
                                                     ~/.latch-works/oriel-rs/sync."
                                                }),
                                        ),
                                )
                            })
                            .children(
                                self.doctor_result
                                    .as_ref()
                                    .map(|result| self.render_doctor(result, cx)),
                            ),
                    )
                },
            )
    }

    fn render_doctor(
        &self,
        result: &oriel_core_sync::DoctorResult,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        div()
            .id("doctor-result")
            .role(Role::Group)
            .test_support()
            .aria_label(if result.ok {
                "Every check passed"
            } else {
                "Some checks failed"
            })
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(if result.ok {
                                "Every check passed"
                            } else {
                                "Some checks failed"
                            }),
                    )
                    .child(
                        Button::new("doctor-dismiss")
                            .ghost()
                            .small()
                            .icon(IconName::Close)
                            .accessibility_label("Dismiss the connection check")
                            .on_click(cx.listener(|this, _, _, cx| this.dismiss_doctor_result(cx))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .rounded(theme.radius_lg)
                    .bg(theme.group_box)
                    .border_1()
                    .border_color(theme.border)
                    .children(result.checks.iter().enumerate().map(|(index, check)| {
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(10.))
                            .px_4()
                            .py(px(10.))
                            .when(index > 0, |this| {
                                this.border_t_1().border_color(theme.border)
                            })
                            .child(
                                Icon::new(if check.ok {
                                    IconName::CircleCheck
                                } else {
                                    IconName::CircleX
                                })
                                .size(px(16.))
                                .text_color(if check.ok {
                                    theme.success
                                } else {
                                    theme.danger
                                }),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(check.label.clone()),
                                    )
                                    .child(
                                        div().text_xs().text_color(theme.muted_foreground).child(
                                            match &check.detail {
                                                Some(detail) => format!(
                                                    "{} · {detail}",
                                                    if check.ok { "Passed" } else { "Failed" }
                                                ),
                                                None => {
                                                    (if check.ok { "Passed" } else { "Failed" })
                                                        .to_owned()
                                                }
                                            },
                                        ),
                                    ),
                            )
                    })),
            )
    }

    /// The profile's own actions: edit, check, the run log, its folder in View and Tidy, delete.
    fn render_profile_menu(&self, profile: &Profile, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity();
        let id = profile.id.clone();
        let running = self.run.running;
        Button::new("sync-profile-menu")
            .ghost()
            .small()
            .icon(IconName::Ellipsis)
            .accessibility_label("Profile actions")
            .dropdown_menu(move |menu, _, _| {
                let (edit, check, log, delete) =
                    (this.clone(), this.clone(), this.clone(), this.clone());
                let (viewed, tidied) = (this.clone(), this.clone());
                let (edit_id, delete_id) = (id.clone(), id.clone());
                menu.item(
                    PopupMenuItem::new("Edit profile…")
                        .disabled(running)
                        .on_click(move |_, window, cx| {
                            edit.update(cx, |this, cx| {
                                this.start_edit_profile(&edit_id, window, cx)
                            });
                        }),
                )
                .item(
                    PopupMenuItem::new("Check connection")
                        .disabled(running)
                        .on_click(move |_, window, cx| {
                            check.update(cx, |this, cx| this.check_connection(window, cx));
                        }),
                )
                .item(PopupMenuItem::new("Run log  ⌘L").on_click(move |_, _, cx| {
                    log.update(cx, |this, cx| this.toggle_run_log(cx));
                }))
                .separator()
                .item(
                    PopupMenuItem::new("Open in View").on_click(move |_, _, cx| {
                        viewed.update(cx, |this, cx| this.hand_off_source(ModeId::View, cx));
                    }),
                )
                .item(
                    PopupMenuItem::new("Tidy this folder").on_click(move |_, _, cx| {
                        tidied.update(cx, |this, cx| this.hand_off_source(ModeId::Tidy, cx));
                    }),
                )
                .separator()
                .item(
                    PopupMenuItem::new("Delete profile…")
                        .disabled(running)
                        .on_click(move |_, window, cx| {
                            delete.update(cx, |this, cx| {
                                this.confirm_delete_profile(&delete_id, window, cx);
                            });
                        }),
                )
            })
    }

    fn render_plan_actions(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(reviewed) = &self.plan else {
            return div().into_any_element();
        };
        let counts = reviewed.plan.counts;
        let push_count = counts.to_push();
        let push_bytes = reviewed.plan.push_bytes();
        let running = self.run.running;
        let pushed = self.push_completed;
        let prune = self.prune_availability();
        let show_run_state = self.shows_run_state();
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .child(
                Button::new("sync-plan")
                    .icon(IconName::RotateCw)
                    .label("Re-plan")
                    .when(pushed && !show_run_state, |this| this.primary())
                    .disabled(running)
                    .on_click(cx.listener(|this, _, window, cx| this.plan_now(window, cx))),
            )
            .when(counts.delete > 0, |this| {
                let (enabled, tooltip) = match &prune {
                    PruneAvailability::Enabled { delete_count } => (
                        true,
                        format!(
                            "Delete the {} remote entries this plan lists",
                            format_count(*delete_count)
                        ),
                    ),
                    PruneAvailability::Disabled { reason } => (false, (*reason).to_owned()),
                };
                this.child(
                    Button::new("sync-prune")
                        // Locked until the plan's push has run, as Electron Oriel draws it.
                        .when(!enabled, |this| this.icon(Icon::new(IconName::Lock)))
                        .label(format!(
                            "Prune {}{}",
                            format_count(counts.delete),
                            if enabled { "…" } else { "" }
                        ))
                        .when(enabled, |this| this.danger())
                        .tooltip(tooltip.clone())
                        .accessibility_label(format!("Prune {}", format_count(counts.delete)))
                        .disabled(running || !enabled)
                        .on_click(
                            cx.listener(|this, _, window, cx| this.confirm_prune(window, cx)),
                        ),
                )
            })
            .when(!pushed, |this| {
                this.child(
                    Button::new("sync-push")
                        .primary()
                        .icon(IconName::ArrowUp)
                        .label(if push_count == 0 {
                            "Nothing to push".to_owned()
                        } else {
                            format!(
                                "Push {} · {}",
                                format_count(push_count),
                                format_bytes(push_bytes as f64)
                            )
                        })
                        .disabled(running || push_count == 0)
                        .on_click(cx.listener(|this, _, window, cx| this.push_now(window, cx))),
                )
            })
            .into_any_element()
    }

    fn render_no_plan(&self, profile: &Profile, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let planning = self.run.running && self.run.progress.kind == Some(RunAction::Plan);
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .gap_3()
            .p_10()
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("No plan yet"),
            )
            .child(
                div()
                    .max_w(px(420.))
                    .text_sm()
                    .text_center()
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "Plan compares {} with {}. Nothing changes on the server until you push.",
                        profile.source_root, profile.api_url
                    )),
            )
            .child(
                div()
                    .id("sync-source-root")
                    .role(Role::Status)
                    .test_support()
                    .aria_label(profile.source_root.clone())
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(profile.source_root.clone()),
            )
            .child(
                div().mt_2().child(
                    Button::new("sync-plan")
                        .primary()
                        .large()
                        .label(if planning { "Planning…" } else { "Plan" })
                        .loading(planning)
                        .disabled(self.run.running)
                        .on_click(cx.listener(|this, _, window, cx| this.plan_now(window, cx))),
                ),
            )
    }

    fn render_plan(&self, profile: &Profile, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let Some(reviewed) = &self.plan else {
            return div().into_any_element();
        };
        let plan = &reviewed.plan;
        let show_run_state = self.shows_run_state();
        let mut bytes_by_action = std::collections::HashMap::new();
        for item in &plan.items {
            let size = item
                .local
                .as_ref()
                .map(|local| local.size)
                .or(item.remote.as_ref().map(|remote| remote.size))
                .unwrap_or(0);
            *bytes_by_action.entry(item.action).or_insert(0u64) += size;
        }
        let changes = plan.counts.changes();
        let filters: AnyElement = if show_run_state {
            let mut counts = [0usize; 4];
            for item in plan
                .items
                .iter()
                .filter(|item| item.action != SyncPlanAction::Keep)
            {
                counts[0] += 1;
                match self.run.item_states.get(&item.path) {
                    Some(state) if state.is_settled() => counts[2] += 1,
                    Some(ItemState::Failed(_)) => counts[3] += 1,
                    _ => counts[1] += 1,
                }
            }
            Segmented::new("sync-run-filter", "Run filter")
                .items(
                    [
                        (RunFilter::All, "All", counts[0]),
                        (RunFilter::Remaining, "Remaining", counts[1]),
                        (RunFilter::Done, "Done", counts[2]),
                        (RunFilter::Failed, "Failed", counts[3]),
                    ]
                    .into_iter()
                    .map(|(filter, label, count)| {
                        SegmentedItem::new(
                            SharedString::from(format!("run-filter-{label}")),
                            format!("{label} {}", format_count(count)),
                        )
                        .selected(self.run_filter == filter)
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.set_run_filter(filter, cx)),
                        )
                    }),
                )
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_row()
                .gap_2()
                .children(
                    [
                        SyncPlanAction::Upload,
                        SyncPlanAction::Update,
                        SyncPlanAction::Delete,
                    ]
                    .into_iter()
                    .filter(|action| match action {
                        SyncPlanAction::Upload => plan.counts.upload > 0,
                        SyncPlanAction::Update => plan.counts.update > 0,
                        _ => plan.counts.delete > 0,
                    })
                    .map(|action| {
                        let count = match action {
                            SyncPlanAction::Upload => plan.counts.upload,
                            SyncPlanAction::Update => plan.counts.update,
                            _ => plan.counts.delete,
                        };
                        let selected = self.action_filter.contains(&action);
                        let dimmed = !self.action_filter.is_empty() && !selected;
                        let text =
                            format!("{} to {}", format_count(count), plan_action_key(action));
                        let detail = (action != SyncPlanAction::Delete).then(|| {
                            format_bytes(*bytes_by_action.get(&action).unwrap_or(&0) as f64)
                        });
                        Button::new(SharedString::from(format!(
                            "plan-count-{}",
                            plan_action_key(action)
                        )))
                        .small()
                        .outline()
                        .selected(selected)
                        .accessibility_label(text.clone())
                        .tooltip(format!("Show only what to {}", plan_action_key(action)))
                        .when(dimmed, |this| this.opacity(0.5))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .child(
                                    div()
                                        .size(px(8.))
                                        .rounded_full()
                                        .bg(plan_action_color(action, cx)),
                                )
                                .child(text)
                                .children(detail.map(|detail| {
                                    div().text_color(theme.muted_foreground).child(detail)
                                })),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.toggle_action_filter(action, cx);
                        }))
                    }),
                )
                .into_any_element()
        };
        let empty_hint = if changes == 0 {
            "Everything is in sync. Nothing to push or prune."
        } else {
            "No changed items match this filter."
        };
        let rows = self.rows.len();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_shrink_0()
                    .gap_2()
                    .px_5()
                    .py(px(10.))
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .truncate()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{} \u{2192} {}",
                                plan.source_root.display(),
                                profile.api_url
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .child(filters)
                            .child(
                                div()
                                    .ml_auto()
                                    .w(px(240.))
                                    .max_w(gpui_kit::relative(0.4))
                                    .child(
                                        Input::new(&self.filter)
                                            .id("plan-filter")
                                            .aria_label("Filter plan paths")
                                            .small(),
                                    ),
                            ),
                    ),
            )
            .child(if rows == 0 {
                div()
                    .flex_1()
                    .py_12()
                    .text_center()
                    .text_size(px(13.))
                    .text_color(theme.muted_foreground)
                    .child(status_text("plan-empty", empty_hint))
                    .into_any_element()
            } else {
                uniform_list(
                    "plan-rows",
                    rows,
                    cx.processor(|this, range: Range<usize>, _, cx| this.render_rows(range, cx)),
                )
                .track_scroll(&self.scroll)
                .flex_1()
                .min_h_0()
                .into_any_element()
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .flex_shrink_0()
                    .items_center()
                    .gap_3()
                    .px_5()
                    .py_3()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(status_text(
                        "plan-count-keep",
                        format!("{} unchanged", format_count(plan.counts.keep)),
                    ))
                    .when(plan.skipped > 0, |this| {
                        this.child(
                            Button::new("plan-skipped")
                                .ghost()
                                .xsmall()
                                .label(format!(
                                    "{} skipped · {}",
                                    format_count(plan.skipped),
                                    if self.show_skipped { "hide" } else { "why?" }
                                ))
                                .on_click(cx.listener(|this, _, _, cx| this.toggle_skipped(cx))),
                        )
                    }),
            )
            .when(self.show_skipped, |this| {
                this.child(
                    div()
                        .id("plan-skipped-list")
                        .flex()
                        .flex_col()
                        .flex_shrink_0()
                        .max_h(px(160.))
                        .overflow_y_scroll()
                        .px_5()
                        .pb_4()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .children(plan.skipped_entries.iter().map(|entry| {
                            let reason = serde_json::to_value(entry.reason)
                                .ok()
                                .and_then(|value| value.as_str().map(str::to_owned))
                                .unwrap_or_default();
                            div()
                                .flex()
                                .flex_row()
                                .gap_3()
                                .py_0p5()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_color(theme.foreground)
                                        .child(entry.path.clone()),
                                )
                                .child(reason)
                        })),
                )
            })
            .into_any_element()
    }

    fn render_rows(&mut self, range: Range<usize>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = cx.theme().clone();
        let show_state = self.shows_run_state();
        self.rows[range]
            .iter()
            .map(|row| {
                let indent = |depth: usize| px(20. + depth as f32 * 16.);
                match row.clone() {
                    RowModel::Folder {
                        depth,
                        path,
                        label,
                        size,
                        item_count,
                        open,
                        paths,
                    } => {
                        let progress = show_state.then(|| {
                            paths.iter().fold((0usize, 0usize), |(done, failed), path| {
                                match self.run.item_states.get(path) {
                                    Some(state) if state.is_settled() => (done + 1, failed),
                                    Some(ItemState::Failed(_)) => (done, failed + 1),
                                    _ => (done, failed),
                                }
                            })
                        });
                        div()
                            .id(SharedString::from(format!("plan-folder-{path}")))
                            .w_full()
                            .role(Role::Button)
                            .test_support()
                            .aria_label(format!("{label}/"))
                            .aria_expanded(open)
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(10.))
                            .h(px(ROW_HEIGHT))
                            .pl(indent(depth))
                            .pr_5()
                            .border_b_1()
                            .border_color(theme.border)
                            .hover(|style| style.bg(theme.accent))
                            .child(
                                Icon::new(if open {
                                    IconName::ChevronDown
                                } else {
                                    IconName::ChevronRight
                                })
                                .size(px(14.))
                                .text_color(theme.muted_foreground),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!("{label}/")),
                            )
                            .child(
                                div()
                                    .w(px(84.))
                                    .text_right()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(format_size(Some(size))),
                            )
                            .child(
                                div()
                                    .w(px(72.))
                                    .text_right()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(match progress {
                                        Some((done, failed)) => format!(
                                            "{}/{item_count}{}",
                                            done + failed,
                                            if failed > 0 {
                                                format!(" ·{failed}\u{2715}")
                                            } else {
                                                String::new()
                                            }
                                        ),
                                        None => format_count(item_count),
                                    }),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_folder(&path, open, cx);
                            }))
                            .into_any_element()
                    }
                    RowModel::More {
                        depth,
                        folder,
                        label,
                        hidden,
                    } => div()
                        .id(SharedString::from(format!("plan-more-{folder}")))
                        .w_full()
                        .role(Role::Button)
                        .test_support()
                        .flex()
                        .items_center()
                        .h(px(ROW_HEIGHT))
                        .pl(indent(depth))
                        .pr_5()
                        .border_b_1()
                        .border_color(theme.border)
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .hover(|style| style.bg(theme.accent).text_color(theme.foreground))
                        .child(format!(
                            "Show {} more in {}",
                            format_count(hidden),
                            if label.is_empty() {
                                "this folder"
                            } else {
                                label.as_str()
                            }
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| this.show_all_in(&folder, cx)))
                        .into_any_element(),
                    RowModel::File {
                        depth,
                        path,
                        name,
                        action,
                        size,
                    } => {
                        let state = show_state
                            .then(|| self.run.item_states.get(&path).cloned())
                            .flatten();
                        let mark: AnyElement = match &state {
                            Some(ItemState::Active) => Spinner::new().xsmall().into_any_element(),
                            Some(ItemState::Done | ItemState::Skipped(_)) => {
                                Icon::new(IconName::Check)
                                    .size(px(14.))
                                    .text_color(theme.success)
                                    .into_any_element()
                            }
                            Some(ItemState::Failed(_)) => Icon::new(IconName::Close)
                                .size(px(14.))
                                .text_color(theme.danger)
                                .into_any_element(),
                            None => div().into_any_element(),
                        };
                        let note = match &state {
                            Some(ItemState::Failed(error)) => Some((error.clone(), theme.danger)),
                            Some(ItemState::Skipped(reason)) => {
                                Some((format!("Skipped: {reason}"), theme.muted_foreground))
                            }
                            _ => None,
                        };
                        let faded = state.as_ref().is_some_and(ItemState::is_settled);
                        div()
                            .id(SharedString::from(format!("plan-file-{path}")))
                            .w_full()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(10.))
                            .h(px(ROW_HEIGHT))
                            .pl(indent(depth))
                            .pr_5()
                            .border_b_1()
                            .border_color(theme.border)
                            .when(matches!(state, Some(ItemState::Active)), |this| {
                                this.bg(theme.primary.opacity(0.08))
                            })
                            .when(matches!(state, Some(ItemState::Failed(_))), |this| {
                                this.bg(theme.danger.opacity(0.07))
                            })
                            .child(div().w(px(16.)).flex().justify_center().child(mark))
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(10.))
                                    .flex_1()
                                    .min_w_0()
                                    .when(faded, |this| this.opacity(0.45))
                                    .child(
                                        div()
                                            .w(px(60.))
                                            .flex_shrink_0()
                                            .py_0p5()
                                            .rounded(theme.radius)
                                            .text_center()
                                            .text_xs()
                                            .font_weight(FontWeight::MEDIUM)
                                            .bg(plan_action_color(action, cx).opacity(0.12))
                                            .text_color(plan_action_color(action, cx))
                                            .child(plan_action_label(action)),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(px(13.))
                                            .child(name),
                                    ),
                            )
                            .children(note.map(|(note, color)| {
                                div()
                                    .max_w(px(260.))
                                    .truncate()
                                    .text_xs()
                                    .text_color(color)
                                    .child(note)
                            }))
                            .child(
                                div()
                                    .w(px(84.))
                                    .text_right()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(format_size(size)),
                            )
                            // The lane the folder rows count their items in.
                            .child(
                                div()
                                    .w(px(72.))
                                    .text_right()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(match &state {
                                        Some(ItemState::Skipped(_)) => "Skipped",
                                        Some(ItemState::Failed(_)) => "Failed",
                                        _ => "",
                                    }),
                            )
                            .into_any_element()
                    }
                }
            })
            .collect()
    }

    fn render_run_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let progress = &self.run.progress;
        let running = self.run.running;
        let item_run = matches!(progress.kind, Some(RunAction::Push | RunAction::Prune));
        let elapsed = progress.ended_at.unwrap_or_else(|| self.run.now_ms());
        let body: AnyElement = if item_run && progress.queued_at.is_some() {
            self.render_item_run(elapsed, cx).into_any_element()
        } else {
            let title = match progress.kind {
                Some(RunAction::Doctor) => "Running doctor".to_owned(),
                Some(RunAction::Plan) => "Planning".to_owned(),
                Some(kind) => format!("Preparing {}", kind.as_str()),
                None => "Preparing run".to_owned(),
            };
            div()
                .flex()
                .flex_col()
                .gap_3()
                .p_4()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_baseline()
                        .gap_2()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(if running {
                                    title
                                } else {
                                    self.run.label.clone()
                                }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(run::format_clock(elapsed)),
                        ),
                )
                .child(
                    Progress::new("run-preparing")
                        .loading(running)
                        .value(if running { 0. } else { 100. }),
                )
                .child(
                    div()
                        .truncate()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(self.run.label.clone()),
                )
                .when(progress.scan_files_found > 0, |this| {
                    this.child(
                        div()
                            .flex()
                            .flex_row()
                            .gap_3()
                            .child(stat("files", format_count(progress.scan_files_found), None))
                            .child(stat(
                                "hashed",
                                format_bytes(progress.bytes_hashed as f64),
                                None,
                            )),
                    )
                })
                .into_any_element()
        };
        let prune = self.prune_availability();
        div()
            .id("run-panel")
            .role(Role::Group)
            .test_support()
            .aria_label("Run")
            .absolute()
            .right_4()
            .bottom_4()
            .w(px(RUN_PANEL_WIDTH))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.popover)
            .text_color(theme.popover_foreground)
            .border_1()
            .border_color(theme.border)
            .shadow_lg()
            .child(body)
            .child(div().flex().flex_col().gap_2().p_4().map(|this| {
                if running {
                    this.child(
                        Button::new("run-cancel")
                            .label(format!(
                                "Cancel {}",
                                progress.kind.map_or("run", RunAction::as_str)
                            ))
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_run(cx))),
                    )
                    .when(progress.kind == Some(RunAction::Push), |this| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(
                            "Items already uploading stop with it. Pushing again \
                                         picks up what is left.",
                        ))
                    })
                } else {
                    this.child(
                        Button::new("run-done")
                            .primary()
                            .label("Done")
                            .on_click(cx.listener(|this, _, _, cx| this.dismiss_run_panel(cx))),
                    )
                    .when(
                        progress.kind == Some(RunAction::Push)
                            && matches!(prune, PruneAvailability::Enabled { .. }),
                        |this| {
                            let count = match prune {
                                PruneAvailability::Enabled { delete_count } => delete_count,
                                PruneAvailability::Disabled { .. } => 0,
                            };
                            this.child(
                                Button::new("run-prune")
                                    .danger()
                                    .label(format!("Prune {}…", format_count(count)))
                                    .tooltip(format!(
                                        "Delete the {} the reviewed plan lists",
                                        run::describe_remote_entries(count)
                                    ))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.confirm_prune(window, cx);
                                    })),
                            )
                        },
                    )
                    .when(
                        progress.kind == Some(RunAction::Push) && progress.failed > 0,
                        |this| {
                            this.child(
                                Button::new("run-retry")
                                    .label(format!(
                                        "Retry {} failed",
                                        format_count(progress.failed)
                                    ))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.push_now(window, cx);
                                    })),
                            )
                        },
                    )
                }
            }))
    }

    fn render_item_run(&self, elapsed: f64, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let progress = &self.run.progress;
        let running = self.run.running;
        let by_bytes = progress.bytes_total > 0;
        let processed = progress.pushed + progress.failed + progress.skipped;
        let bytes_processed = progress.bytes_done + progress.bytes_failed;
        let ratio = self.run.ratio().unwrap_or(0.0);
        let rate = self.run.rate();
        let name = if progress.kind == Some(RunAction::Prune) {
            "Prune"
        } else {
            "Push"
        };
        let finished = match progress.phase {
            RunPhase::Cancelled => format!("{name} cancelled"),
            RunPhase::Error => format!("{name} failed"),
            _ if progress.failed > 0 => format!("{name} finished with failures"),
            _ => format!("{name} complete"),
        };
        let bar_color = if !running
            && (progress.failed > 0
                || matches!(progress.phase, RunPhase::Error | RunPhase::Cancelled))
        {
            theme.danger
        } else if !running && progress.phase == RunPhase::Done {
            theme.success
        } else {
            theme.primary
        };
        let verb = if progress.kind == Some(RunAction::Prune) {
            "deleted"
        } else {
            "pushed"
        };
        let chart_start = progress.queued_at.unwrap_or(0.0);
        let series = by_bytes
            .then(|| run::throughput_series(CHART_BUCKETS, chart_start, elapsed, &progress.spans));
        let failure_marks = run::failure_marks(chart_start, elapsed, &progress.failure_times);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_4()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(if running {
                        div()
                            .flex()
                            .flex_row()
                            .items_baseline()
                            .child(
                                div()
                                    .text_2xl()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("{}%", (ratio * 100.).floor() as u32)),
                            )
                            .child(
                                div()
                                    .ml_auto()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(match self.run.remaining_ms() {
                                        Some(left) => format!("{} left", run::format_clock(left)),
                                        None => "Estimating…".to_owned(),
                                    }),
                            )
                            .into_any_element()
                    } else {
                        div()
                            .flex()
                            .flex_row()
                            .items_baseline()
                            .gap_2()
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(status_text("run-title", finished)),
                            )
                            .child(
                                div()
                                    .ml_auto()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(run::format_clock(elapsed)),
                            )
                            .into_any_element()
                    })
                    .child(
                        Progress::new("run-progress")
                            .value(ratio * 100.)
                            .color(bar_color)
                            .accessibility_label("Run progress"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(if by_bytes {
                                format!(
                                    "{} / {}",
                                    format_bytes(bytes_processed as f64),
                                    format_bytes(progress.bytes_total as f64)
                                )
                            } else {
                                format!(
                                    "{} / {} items",
                                    format_count(processed),
                                    format_count(progress.item_total)
                                )
                            })
                            .when(running, |this| {
                                this.child(
                                    div()
                                        .ml_auto()
                                        .child(format!("{} so far", run::format_clock(elapsed))),
                                )
                            }),
                    ),
            )
            .children(series.map(|series| {
                let peak = series.iter().copied().fold(1.0f64, f64::max);
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_4()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_baseline()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child("Throughput"),
                            )
                            .child(
                                div()
                                    .ml_auto()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!(
                                        "{}/s{}",
                                        format_bytes(rate),
                                        if running { "" } else { " on average" }
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .id("run-throughput")
                            .role(Role::Image)
                            .test_support()
                            .aria_label("Upload throughput over the run")
                            .relative()
                            .flex()
                            .flex_row()
                            .items_end()
                            .gap(px(1.))
                            .h(px(46.))
                            .children(series.into_iter().map(|rate| {
                                div()
                                    .flex_1()
                                    .h(px(((rate / peak) * 42.0) as f32 + 2.))
                                    .rounded_t(px(1.))
                                    .bg(theme.primary.opacity(0.55))
                            }))
                            // Each failure as a red dashed line where it happened.
                            .children(failure_marks.iter().enumerate().map(|(ix, at)| {
                                div()
                                    .id(("run-failure-mark", ix))
                                    .absolute()
                                    .top_0()
                                    .bottom_0()
                                    .left(relative(*at))
                                    .w(px(1.))
                                    .border_l_1()
                                    .border_dashed()
                                    .border_color(theme.danger)
                            })),
                    )
            }))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap_3()
                    .p_4()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(stat(
                        verb,
                        format!(
                            "{} / {}",
                            format_count(progress.pushed),
                            format_count(progress.item_total)
                        ),
                        Some(theme.success),
                    ))
                    .child(stat(
                        "failed",
                        format_count(progress.failed),
                        (progress.failed > 0).then_some(theme.danger),
                    ))
                    .when(progress.skipped > 0, |this| {
                        this.child(stat("skipped", format_count(progress.skipped), None))
                    }),
            )
    }

    fn render_log(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let beside_run = self.shows_run_panel();
        div()
            .id("run-log")
            .role(Role::Log)
            .test_support()
            .aria_label("Run log")
            .absolute()
            .bottom_4()
            .left_4()
            .map(|this| {
                if beside_run {
                    this.right(px(RUN_PANEL_WIDTH + 32.))
                } else {
                    this.right_4()
                }
            })
            .h(px(224.))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.popover)
            .border_1()
            .border_color(theme.border)
            .shadow_lg()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .h(px(40.))
                    .flex_shrink_0()
                    .px_4()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Run log"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{} {}",
                                format_count(self.run.logs.len()),
                                if self.run.running {
                                    "lines, live"
                                } else {
                                    "lines"
                                }
                            )),
                    )
                    .child(
                        div().ml_auto().child(
                            Button::new("run-log-close")
                                .ghost()
                                .small()
                                .label("Close")
                                .tooltip("⌘L")
                                .on_click(cx.listener(|this, _, _, cx| this.toggle_run_log(cx))),
                        ),
                    ),
            )
            .child(
                div()
                    .id("run-log-lines")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_4()
                    .py(px(10.))
                    .font_family("Menlo")
                    .text_size(px(11.))
                    .text_color(theme.muted_foreground)
                    .map(|this| {
                        if self.run.logs.is_empty() {
                            this.child(
                                "Nothing logged yet. Plan, Push and Prune write here as they run.",
                            )
                        } else {
                            this.children(
                                self.run.logs.iter().map(|line| div().child(line.clone())),
                            )
                        }
                    }),
            )
    }

    pub(crate) fn render_settings(
        &self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let running = self.run.running;
        let profiles = self.store.profiles();
        div()
            .flex()
            .flex_col()
            .child(
                SettingsGroup::new("Profiles")
                    .children(profiles.iter().map(|profile| {
                        let state = self.store.token_state(&profile.id);
                        let id = profile.id.clone();
                        SettingsRow::new(profile.name.clone())
                            .description(format!(
                                "{} \u{2192} {}",
                                profile.source_root, profile.api_url
                            ))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(if state == TokenState::Unreadable {
                                        theme.danger
                                    } else {
                                        theme.muted_foreground
                                    })
                                    .child(match state {
                                        TokenState::Unreadable => "Token unreadable",
                                        TokenState::Saved => "Token saved",
                                        TokenState::None => "No token saved",
                                    }),
                            )
                            .child(
                                Button::new(SharedString::from(format!(
                                    "settings-edit-{}",
                                    profile.id
                                )))
                                .label("Edit…")
                                .accessibility_label(format!("Edit {}", profile.name))
                                .disabled(running)
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.shell
                                            .update(cx, |shell, cx| shell.go(ModeId::Sync, cx));
                                        this.start_edit_profile(&id, window, cx);
                                    },
                                )),
                            )
                    }))
                    .child(
                        SettingsRow::new(if profiles.is_empty() {
                            "No profiles yet"
                        } else {
                            "New profile"
                        })
                        .description(
                            "A profile pairs a local archive folder with a Pane View server.",
                        )
                        .child(
                            Button::new("settings-add-profile")
                                .icon(IconName::Plus)
                                .label("Add profile")
                                .disabled(running)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.shell
                                        .update(cx, |shell, cx| shell.go(ModeId::Sync, cx));
                                    this.start_create_profile(window, cx);
                                })),
                        ),
                    ),
            )
            .child(SettingsGroup::new("Tokens").child(
                SettingsRow::new(format!("Saved in {}", self.data.sync().display())).description(
                    "Encrypted with a key there that only your user account can read.",
                ),
            ))
    }
}

/// One figure of the run panel: its label above, its value below.
fn stat(label: &'static str, value: String, tone: Option<Hsla>) -> impl IntoElement {
    let id = SharedString::from(format!("run-stat-{label}"));
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .child(
            div()
                .text_xs()
                .child(format!("{}{}", label[..1].to_uppercase(), &label[1..])),
        )
        .child(
            div()
                .id(id)
                .role(Role::Status)
                .test_support()
                .aria_label(value.clone())
                .mt_0p5()
                .truncate()
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .when_some(tone, |this, tone| this.text_color(tone))
                .child(value),
        )
}
