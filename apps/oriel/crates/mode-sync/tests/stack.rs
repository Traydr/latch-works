//! The Sync spec's five cases against the local compose stack: the e2e Pane View
//! (`e2e/stack.json`), seeded with `e2e/.fixtures/archive` through the Lockstep CLI, as
//! `docs/runbooks/e2e.md` sets it up. It pushes `e2e/.fixtures/lockstep-source` and then
//! prunes the seeded archive from the e2e database, so each run needs a freshly seeded server:
//!
//! ```sh
//! (cd docs/localhost && docker compose up -d)
//! E2E_SKIP_BUILD=1 pnpm --filter @latch-works/e2e exec tsx scripts/start-pane-view.ts &
//! HOME=$(mktemp -d) LOCKSTEP_API_TOKEN=e2e-sync-token-0123456789abcdef \
//!   pnpm --filter @latch-works/lockstep start push --source "$PWD/e2e/.fixtures/archive" \
//!   --api-url http://127.0.0.1:3101 --yes
//! cd apps/oriel && cargo test -p oriel-mode-sync --test main stack:: -- --ignored
//! ```
//!
//! The server recreates its database when it starts, so restart it (and seed again) before the
//! next run. Only that local server is ever written to.

use gpui_kit::TestAppContext;
use oriel_core_sync::testing::E2eStack;

use crate::support::{Target, remote_paths, run_sync_spec};

#[gpui_kit::test]
#[ignore = "needs the local stack and a freshly seeded e2e Pane View; see the module's comment"]
fn sync_spec_against_the_local_stack(cx: &mut TestAppContext) {
    let stack = E2eStack::get();
    assert!(
        stack.archive.is_dir(),
        "no e2e fixtures (pnpm --filter @latch-works/e2e fixture)"
    );
    let target = Target {
        url: stack.url,
        token: stack.sync_token,
        source: stack.lockstep_source,
        archive: stack.archive,
        source_items: vec!["desk/desk-1.png".to_owned(), "desk/desk-2.png".to_owned()],
    };
    let remote = remote_paths(&target);
    assert!(
        remote.iter().any(|path| path == "root-image.png")
            && !remote.iter().any(|path| path.starts_with("desk/")),
        "the e2e Pane View is not freshly seeded; restart it and seed it again (see above)"
    );
    let scratch = tempfile::tempdir().unwrap();
    run_sync_spec(cx, &target, &scratch.path().join("data"));
}
