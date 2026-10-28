//! Tidy: Overview is home. Duplicates, Convert and Clean up are the work, in the order it is best
//! done, and Shrink is the optional AV1 re-encode after them; Library and History are the
//! archive; Holding sits at the foot of the sidebar.

mod library;
mod spike;

pub use library::{LibraryColumn, LibraryDelegate, LibraryPage, LibraryRow, synthetic_rows};

use std::time::Instant;

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Subscription, Window, div, prelude::FluentBuilder as _,
};
use oriel_ui::layout::NavItem;
use oriel_ui::{ModeId, ModeLayout, ShellState, TopBar};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TidyPage {
    Overview,
    Duplicates,
    Convert,
    CleanUp,
    Shrink,
    Library,
    History,
    Holding,
}

impl TidyPage {
    pub const ALL: [TidyPage; 8] = [
        TidyPage::Overview,
        TidyPage::Duplicates,
        TidyPage::Convert,
        TidyPage::CleanUp,
        TidyPage::Shrink,
        TidyPage::Library,
        TidyPage::History,
        TidyPage::Holding,
    ];

    pub fn label(self) -> &'static str {
        match self {
            TidyPage::Overview => "Overview",
            TidyPage::Duplicates => "Duplicates",
            TidyPage::Convert => "Convert",
            TidyPage::CleanUp => "Clean up",
            TidyPage::Shrink => "Shrink",
            TidyPage::Library => "Library",
            TidyPage::History => "History",
            TidyPage::Holding => "Holding",
        }
    }

    fn icon(self) -> IconName {
        match self {
            TidyPage::Overview => IconName::LayoutGrid,
            TidyPage::Duplicates => IconName::Copy,
            TidyPage::Convert => IconName::Repeat2,
            TidyPage::CleanUp => IconName::Sparkles,
            TidyPage::Shrink => IconName::Shrink,
            TidyPage::Library => IconName::Library,
            TidyPage::History => IconName::RotateCcw,
            TidyPage::Holding => IconName::Archive,
        }
    }
}

pub struct TidyMode {
    shell: Entity<ShellState>,
    page: TidyPage,
    /// Phase 0's Library: synthetic rows, shown only when the spike asks for them.
    library: Option<Entity<LibraryPage>>,
    _subscriptions: Vec<Subscription>,
}

impl TidyMode {
    pub fn new(shell: &Entity<ShellState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut page = TidyPage::Overview;
        let library = spike::requested_rows().map(|count| {
            let started = Instant::now();
            let rows = synthetic_rows(count);
            let spike = spike::LibrarySpike::from_environment(started.elapsed());
            page = TidyPage::Library;
            shell.update(cx, |shell, cx| shell.go(ModeId::Tidy, cx));
            cx.new(|cx| LibraryPage::new(rows, spike, window, cx))
        });
        Self {
            shell: shell.clone(),
            page,
            library,
            _subscriptions: vec![cx.observe(shell, |_, _, cx| cx.notify())],
        }
    }

    /// This mode's section of the one Settings page (⌘,). The shell draws the page and calls this
    /// for the mode's section; the mode owns what is in it.
    pub fn settings_section(&mut self, _: &mut Window, _: &mut Context<Self>) -> AnyElement {
        div().child("No settings yet.").into_any_element()
    }

    /// Shows `rows` in the Library, as the spike does, for tests.
    pub fn show_library(
        &mut self,
        rows: Vec<LibraryRow>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.library = Some(cx.new(|cx| LibraryPage::new(rows, None, window, cx)));
        self.show(TidyPage::Library, cx);
    }

    pub fn library(&self) -> Option<&Entity<LibraryPage>> {
        self.library.as_ref()
    }

    pub fn page(&self) -> TidyPage {
        self.page
    }

    pub fn show(&mut self, page: TidyPage, cx: &mut Context<Self>) {
        if self.page != page {
            self.page = page;
            cx.notify();
        }
    }

    fn navigation(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let rail = self.shell.read(cx).rail();
        div()
            .flex()
            .flex_col()
            .w_full()
            .gap_0p5()
            .px_2()
            .pt_2()
            .when(rail, |this| this.items_center())
            .children(TidyPage::ALL.map(|page| {
                NavItem::new(
                    SharedString::from(format!("tidy-{}", page.label())),
                    Icon::new(page.icon()),
                    page.label(),
                )
                .rail(rail)
                .current(page == self.page)
                .on_click(cx.listener(move |this, _, _, cx| this.show(page, cx)))
            }))
    }
}

impl Render for TidyMode {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.page.label();
        ModeLayout::new(&self.shell)
            .navigation(self.navigation(cx))
            .child(TopBar::new(&self.shell, title))
            .child(match (&self.library, self.page) {
                (Some(library), TidyPage::Library) => {
                    div().flex_1().min_h_0().child(library.clone())
                }
                _ => div()
                    .flex_1()
                    .min_h_0()
                    .p_4()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!("{title} comes in a later phase.")),
            })
    }
}
