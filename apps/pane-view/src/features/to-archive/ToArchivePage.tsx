import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ArchivedView } from "./ArchivedView";
import { FocusRun } from "./FocusRun";
import { FootNotice, useFootNotice } from "./FootNotice";
import { extractUrls } from "./link-sites";
import type { ArchiveLink } from "./to-archive-contract";
import { useToArchiveQuery } from "./to-archive-queries";
import { useLinkCommands } from "./use-link-commands";
import { ALL_SITES, WaitingView } from "./WaitingView";

const route = getRouteApi("/_authed/to-archive");

/** How long a link pointed at by "Show" stays marked. */
const HIGHLIGHT_MS = 2_500;

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
  );
}

/** To archive (plan 068): links waiting to be archived, by site, and the ones already done. */
export function ToArchivePage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const tab = search.tab ?? "to-archive";
  const site = search.site ?? ALL_SITES;
  const waiting = useToArchiveQuery();
  const links = waiting.data ?? [];
  const { dismiss, notice, notify } = useFootNotice();
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const show = (link: ArchiveLink) => {
    void navigate({ search: { tab: "to-archive" } });
    setHighlightId(link.id);
  };

  const commands = useLinkCommands({ notify, onShow: show });
  const addRef = useRef(commands.add);

  addRef.current = commands.add;

  useEffect(() => {
    if (!highlightId) return;

    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);

    return () => window.clearTimeout(timer);
  }, [highlightId]);

  // ⌘V anywhere on the page, outside a text field, adds the links on the clipboard.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target)) return;

      const text = event.clipboardData?.getData("text") ?? "";

      if (extractUrls(text).length === 0) return;

      event.preventDefault();
      addRef.current(text);
    };

    document.addEventListener("paste", onPaste);

    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const setSite = (next: string) =>
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, site: next === ALL_SITES ? undefined : next }),
    });

  if (search.run) {
    return (
      <main className="min-h-dvh bg-background text-foreground">
        <FocusRun
          key={site}
          allLinks={links}
          commands={commands}
          onExit={() => void navigate({ search: (previous) => ({ ...previous, run: undefined }) })}
          onSiteChange={setSite}
          site={site}
        />
        <FootNotice notice={notice} onDismiss={dismiss} />
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pt-8 pb-28">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link
              className="mb-2 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              to="/"
            >
              <ArrowLeft className="size-4" />
              Back to gallery
            </Link>
            <h1 className="text-2xl font-semibold">To archive</h1>
          </div>
          <nav aria-label="Lists" className="flex gap-0.5 rounded-[10px] bg-secondary p-[3px]">
            <TabLink count={links.length} on={tab === "to-archive"} tab="to-archive">
              To archive
            </TabLink>
            <TabLink on={tab === "archived"} tab="archived">
              Archived
            </TabLink>
          </nav>
        </header>

        {waiting.error ? <p className="text-sm text-destructive">{waiting.error.message}</p> : null}

        {tab === "archived" ? (
          <ArchivedView commands={commands} />
        ) : (
          <WaitingView
            commands={commands}
            highlightId={highlightId}
            isLoading={waiting.isLoading}
            links={links}
            onSiteChange={setSite}
            onStart={() => void navigate({ search: (previous) => ({ ...previous, run: true }) })}
            site={site}
          />
        )}
      </div>
      <FootNotice notice={notice} onDismiss={dismiss} />
    </main>
  );
}

function TabLink({
  children,
  count,
  on,
  tab,
}: {
  children: string;
  count?: number;
  on: boolean;
  tab: "to-archive" | "archived";
}) {
  return (
    <Link
      aria-current={on ? "page" : undefined}
      className={cn(
        "touch-target rounded-[7px] px-3 py-1 text-[13px] font-medium text-muted-foreground hover:text-foreground",
        on && "bg-background text-foreground shadow-surface",
      )}
      from="/to-archive"
      search={tab === "archived" ? { tab } : {}}
    >
      {children}
      {count !== undefined ? (
        <span className="ml-1.5 font-normal tabular-nums opacity-60">{count}</span>
      ) : null}
    </Link>
  );
}
