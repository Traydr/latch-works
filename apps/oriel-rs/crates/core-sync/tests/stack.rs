//! Against the local stack: a plan Rust makes for a source equals the Lockstep CLI's plan for it
//! (plan 063, "Keeping two implementations honest"). Both plan the same folder against the same
//! running Pane View, read-only, and their summaries and change lists must agree.
//!
//! These need the e2e Pane View on the local compose stack, seeded through the Lockstep CLI
//! (`docs/runbooks/e2e.md`), and Node with pnpm for the CLI, so they are ignored by default:
//!
//! ```sh
//! (cd docs/localhost && docker compose up -d)
//! pnpm --filter @latch-works/e2e exec tsx scripts/start-pane-view.ts &   # serves :3100
//! HOME=$(mktemp -d) LOCKSTEP_API_TOKEN=e2e-sync-token-0123456789abcdef \
//!   pnpm --filter @latch-works/lockstep start push --source "$PWD/e2e/.fixtures/archive" \
//!   --api-url http://127.0.0.1:3100 --yes
//! cd apps/oriel-rs && cargo test -p oriel-core-sync --test stack -- --ignored
//! ```
//!
//! `ORIEL_RS_SYNC_STACK_URL` and `ORIEL_RS_SYNC_STACK_TOKEN` point them elsewhere; the defaults are
//! the e2e suite's own (`e2e/src/env.ts`). They only ever read from Pane View.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use oriel_core_domain::format_bytes;
use oriel_core_index::SyncPlanAction;
use oriel_core_sync::{
    ApiTarget, HashMode, LockstepPlan, PaneViewClient, PlanOptions, cache_root, plan_sync,
};
use oriel_runtime::{CancelToken, TokioRuntime};

/// The e2e suite's Pane View and sync token (`e2e/src/env.ts`), not a secret.
const E2E_URL: &str = "http://127.0.0.1:3100";
const E2E_TOKEN: &str = "e2e-sync-token-0123456789abcdef";

fn target() -> ApiTarget {
    ApiTarget {
        url: std::env::var("ORIEL_RS_SYNC_STACK_URL").unwrap_or_else(|_| E2E_URL.to_owned()),
        token: std::env::var("ORIEL_RS_SYNC_STACK_TOKEN").unwrap_or_else(|_| E2E_TOKEN.to_owned()),
    }
}

fn repository_root() -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.."))
        .expect("the repository root")
}

/// A plan as the CLI prints it: the summary, the counts, and its first changes.
#[derive(Debug, PartialEq)]
struct PrintedPlan {
    media_files: usize,
    skipped_files: usize,
    total_size: String,
    counts: [usize; 4],
    changes: Vec<(String, String)>,
    more: usize,
}

const PREVIEW: usize = 20;

fn cli_plan(source: &Path, hash: bool) -> PrintedPlan {
    let home = tempfile::tempdir().unwrap();
    let target = target();
    let mut arguments = vec![
        "--silent".to_owned(),
        "--filter".to_owned(),
        "@latch-works/lockstep".to_owned(),
        "start".to_owned(),
        "plan".to_owned(),
        "--source".to_owned(),
        source.to_string_lossy().into_owned(),
        "--api-url".to_owned(),
        target.url.clone(),
    ];
    if hash {
        arguments.push("--hash".to_owned());
    }
    // The CLI remembers its last source under $HOME, so it gets a home of its own.
    let output = Command::new("pnpm")
        .args(&arguments)
        .current_dir(repository_root())
        .env("HOME", home.path())
        .env("LOCKSTEP_API_TOKEN", &target.token)
        .output()
        .expect("run the Lockstep CLI (needs pnpm)");
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(
        output.status.success(),
        "lockstep plan failed: {text}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    parse_printed_plan(&text)
}

fn parse_printed_plan(text: &str) -> PrintedPlan {
    let value = |label: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(label))
            .unwrap_or_else(|| panic!("no {label:?} in {text}"))
            .trim()
            .to_owned()
    };
    let count = |action: &str| {
        text.lines()
            .find_map(|line| line.trim().strip_prefix(&format!("{action}:")))
            .unwrap_or_else(|| panic!("no count for {action}"))
            .trim()
            .parse()
            .unwrap()
    };
    let mut changes = Vec::new();
    let mut more = 0;
    let mut in_changes = false;
    for line in text.lines() {
        if line == "Changes" || line == "First changes" {
            in_changes = true;
            continue;
        }
        if !in_changes {
            continue;
        }
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("... and ") {
            more = rest.trim_end_matches(" more").parse().unwrap();
        } else if let Some((action, path)) = line.split_once(' ') {
            changes.push((action.to_owned(), path.trim_start().to_owned()));
        }
    }
    PrintedPlan {
        media_files: value("Media files:").parse().unwrap(),
        skipped_files: value("Skipped files:").parse().unwrap(),
        total_size: value("Total size:"),
        counts: [
            count("upload"),
            count("update"),
            count("keep"),
            count("delete"),
        ],
        changes,
        more,
    }
}

fn action_name(action: SyncPlanAction) -> &'static str {
    match action {
        SyncPlanAction::Upload => "upload",
        SyncPlanAction::Update => "update",
        SyncPlanAction::Keep => "keep",
        SyncPlanAction::Delete => "delete",
    }
}

/// The Rust plan, printed as the CLI prints one.
fn printed(plan: &LockstepPlan) -> PrintedPlan {
    let changes: Vec<(String, String)> = plan
        .items
        .iter()
        .filter(|item| item.action != SyncPlanAction::Keep)
        .map(|item| (action_name(item.action).to_owned(), item.path.clone()))
        .collect();
    PrintedPlan {
        media_files: plan.total_files,
        skipped_files: plan.skipped,
        total_size: format_bytes(plan.total_bytes as f64),
        counts: [
            plan.counts.upload,
            plan.counts.update,
            plan.counts.keep,
            plan.counts.delete,
        ],
        more: changes.len().saturating_sub(PREVIEW),
        changes: changes.into_iter().take(PREVIEW).collect(),
    }
}

fn rust_plan(source: &Path, hash: bool) -> LockstepPlan {
    let runtime = TokioRuntime::start("sync-stack-test").unwrap();
    let cache = tempfile::tempdir().unwrap();
    let client = PaneViewClient::new(target()).unwrap();
    let options = PlanOptions {
        source_root: source.to_path_buf(),
        hash_cache_root: cache_root(cache.path()),
        hash_mode: if hash { HashMode::All } else { HashMode::None },
        directory_concurrency: None,
        file_concurrency: None,
    };
    futures::executor::block_on(
        runtime.spawn(
            async move { plan_sync(options, Some(&client), None, &CancelToken::new()).await },
        ),
    )
    .unwrap()
    .unwrap()
}

/// A copy of part of the seeded archive with every kind of change: a file with new bytes at the
/// same size, one that grew, one renamed only in case, two new files, and the rest missing.
fn changed_copy(archive: &Path, into: &Path) -> PathBuf {
    let source = into.join("changed-source");
    let mut copied = 0;
    for entry in walk(archive) {
        let relative = entry.strip_prefix(archive).unwrap();
        let text = relative.to_string_lossy();
        if !(text.starts_with("unicode/")
            || text == "root-image.png"
            || text.starts_with("videos/"))
        {
            continue;
        }
        let target = source.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(&entry, &target).unwrap();
        copied += 1;
    }
    assert!(copied >= 3, "the fixture archive is not there");
    let clip = source.join("videos/clip-a.mp4");
    let mut bytes = fs::read(&clip).unwrap();
    bytes[0] ^= 0xff;
    fs::write(&clip, bytes).unwrap();
    let grown = source.join("videos/clip-b.mp4");
    let mut bytes = fs::read(&grown).unwrap();
    bytes.extend_from_slice(b"grown");
    fs::write(&grown, bytes).unwrap();
    fs::rename(source.join("root-image.png"), source.join("Root-Image.PNG")).unwrap();
    fs::create_dir_all(source.join("new")).unwrap();
    fs::write(source.join("new/fresh.jpg"), b"not really a jpeg").unwrap();
    fs::write(source.join("notes.txt"), b"skipped").unwrap();
    source
}

fn walk(folder: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(folder).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
#[ignore = "needs the local stack and the e2e Pane View; see the module's comment"]
fn a_rust_plan_equals_the_lockstep_clis_plan() {
    let fixtures = repository_root().join("e2e/.fixtures");
    let scratch = tempfile::tempdir().unwrap();
    let changed = changed_copy(&fixtures.join("archive"), scratch.path());
    let sources = [
        (fixtures.join("archive"), false),
        (fixtures.join("lockstep-source"), false),
        (changed.clone(), false),
        (changed, true),
    ];
    let mut seen = Vec::new();
    for (source, hash) in sources {
        let cli = cli_plan(&source, hash);
        let rust = printed(&rust_plan(&source, hash));
        assert_eq!(
            rust,
            cli,
            "the plans of {} differ (hash {hash})",
            source.display()
        );
        assert!(cli.media_files > 0);
        seen.push((cli.counts, hash));
    }
    // The four plans between them hold every action: the seeded archive keeps everything, the
    // e2e source uploads two and deletes the rest, and the changed copy updates, by size alone
    // and then by hash too.
    assert_eq!(seen[0].0, [0, 0, 96, 0], "{seen:?}");
    assert_eq!(seen[1].0, [2, 0, 0, 96], "{seen:?}");
    let [upload, update_by_size, ..] = seen[2].0;
    assert_eq!((upload, update_by_size), (1, 1), "{seen:?}");
    assert_eq!(
        seen[3].0[1], 2,
        "hashing finds the same-size edit too: {seen:?}"
    );
}
