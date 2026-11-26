import { Check, Clock, ExternalLink, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMinutesAgo } from "./link-dates";
import { LinkText, SiteBadge, Tag } from "./link-parts";
import { parseLink, siteByKey } from "./link-sites";
import { type ArchiveLink, isRecheck } from "./to-archive-contract";
import type { LinkCommands } from "./use-link-commands";
import { ALL_SITES, countSites } from "./WaitingView";

interface Opened {
  id: string;
  at: Date;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="ml-1 rounded bg-current/15 px-1.5 py-px font-mono text-[11px] font-normal">
      {children}
    </kbd>
  );
}

/** True when a key press belongs to a text field or carries a modifier, so focus mode leaves it alone. */
function isForeignKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;

  const target = event.target;

  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
  );
}

/**
 * Focus mode (plan 068, mock H): one link at a time from the front of the list. ↵ opens it in a
 * new tab; back in this tab, Archived becomes the main button. A archives, L sends it to the
 * back, Backspace removes it, Esc leaves. Every action offers Undo in the foot notice.
 */
export function FocusRun({
  allLinks,
  commands,
  onExit,
  onSiteChange,
  site,
}: {
  allLinks: readonly ArchiveLink[];
  commands: LinkCommands;
  onExit: () => void;
  onSiteChange: (site: string) => void;
  site: string;
}) {
  const links = site === ALL_SITES ? allLinks : allLinks.filter((link) => link.site === site);
  const [current, ...rest] = links;
  const [opened, setOpened] = useState<Opened | null>(null);
  const [, setVisibleAgainAt] = useState(0);
  const [tally, setTally] = useState({ archived: 0, handled: 0 });
  const total = useRef<number | null>(null);

  total.current ??= links.length;

  const isBack = current !== undefined && opened?.id === current.id;

  // Re-render when the owner comes back from the site, so "Opened N minutes ago" is current.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setVisibleAgainAt(Date.now());
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // A clicked button keeps focus; the next Enter would press whatever button now stands there.
  const releaseFocus = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  const open = (link: ArchiveLink) => {
    window.open(link.url, "_blank", "noopener,noreferrer");
    setOpened({ at: new Date(), id: link.id });
    releaseFocus();
  };

  const handle = (archived: boolean) => {
    releaseFocus();
    setTally((last) => ({
      archived: last.archived + (archived ? 1 : 0),
      handled: last.handled + 1,
    }));
  };

  const archive = (link: ArchiveLink) => {
    commands.archive(link);
    handle(true);
  };

  const later = (link: ArchiveLink) => {
    commands.later(link);
    handle(false);
  };

  const remove = (link: ArchiveLink) => {
    commands.remove(link);
    handle(false);
  };

  const keyActions = useRef({ archive, later, onExit, open, remove, current });

  keyActions.current = { archive, later, onExit, open, remove, current };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A held key repeats; only the first press acts, so holding ⌫ can't remove a run of links.
      if (event.repeat || isForeignKey(event)) return;

      const actions = keyActions.current;

      if (event.key === "Escape") {
        event.preventDefault();
        actions.onExit();

        return;
      }

      const link = actions.current;

      if (!link) return;

      switch (event.key) {
        case "Enter":
          // A focused button presses itself on Enter; only a bare Enter opens.
          if (
            event.target instanceof HTMLButtonElement ||
            event.target instanceof HTMLAnchorElement
          ) {
            return;
          }

          event.preventDefault();
          actions.open(link);
          break;
        case "a":
        case "A":
          event.preventDefault();
          actions.archive(link);
          break;
        case "l":
        case "L":
          event.preventDefault();
          actions.later(link);
          break;
        case "Backspace":
        case "Delete":
          event.preventDefault();
          actions.remove(link);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sites = countSites(allLinks);
  const runTotal = Math.max(total.current, tally.handled + links.length);
  const position = Math.min(tally.handled + 1, runTotal);
  const parsed = current ? parseLink(current.url) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 px-5 py-4">
        <Button onClick={onExit} variant="ghost">
          <X />
          Done
          <Kbd>esc</Kbd>
        </Button>
        <label className="relative">
          <span className="sr-only">Site</span>
          <select
            className="h-8 appearance-none rounded-full bg-secondary pr-8 pl-3 text-[13px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) => {
              // A focused select would keep the run's keys (and change site on A or L).
              event.currentTarget.blur();
              onSiteChange(event.target.value);
            }}
            value={site}
          >
            <option value={ALL_SITES}>All sites · {allLinks.length}</option>
            {sites.map((entry) => (
              <option key={entry.site} value={entry.site}>
                {siteByKey(entry.site).label} · {entry.count}
              </option>
            ))}
          </select>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-muted-foreground"
          >
            ▼
          </span>
        </label>
        <div
          aria-hidden="true"
          className="h-1 max-w-sm min-w-24 flex-1 overflow-hidden rounded-full bg-secondary"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${runTotal === 0 ? 100 : (tally.handled / runTotal) * 100}%` }}
          />
        </div>
        <span className="text-[13px] text-muted-foreground tabular-nums">
          {current ? `${position} of ${runTotal}` : `${runTotal} of ${runTotal}`} · {tally.archived}{" "}
          archived
        </span>
      </header>

      <div className="grid flex-1 place-items-center px-5 pb-16">
        {current ? (
          <div className="grid w-full max-w-xl gap-5">
            <article
              aria-label="Current link"
              className="grid gap-4 rounded-2xl bg-popover p-7 shadow-float"
            >
              <div className="flex items-center gap-3">
                <SiteBadge className="size-11 rounded-[11px] text-sm" site={current.site} />
                <div className="min-w-0">
                  <div className="text-[12.5px] text-muted-foreground">
                    {siteByKey(current.site).label}
                  </div>
                  <div className="flex items-center font-semibold">
                    <span className="truncate">{parsed?.label ?? current.canonicalUrl}</span>
                    {isRecheck(current) ? <Tag tone="warning">recheck</Tag> : null}
                  </div>
                </div>
              </div>
              <p className="font-mono text-[13px] break-all text-muted-foreground">
                {current.canonicalUrl}
              </p>
              {isBack && opened ? (
                <p className="text-[13px] text-muted-foreground">
                  Opened {formatMinutesAgo(opened.at)}
                </p>
              ) : null}
              <div className="mt-1 grid grid-cols-[2fr_1fr_1fr] gap-2">
                {isBack ? (
                  <>
                    <FocusButton key="archive-main" onClick={() => archive(current)} primary>
                      <Check />
                      Archived
                      <Kbd>A</Kbd>
                    </FocusButton>
                    <FocusButton key="open-again" onClick={() => open(current)}>
                      <ExternalLink />
                      Again
                      <Kbd>↵</Kbd>
                    </FocusButton>
                  </>
                ) : (
                  <>
                    <FocusButton key="open-main" onClick={() => open(current)} primary>
                      <ExternalLink />
                      Open
                      <Kbd>↵</Kbd>
                    </FocusButton>
                    <FocusButton
                      className="text-success"
                      key="archive"
                      onClick={() => archive(current)}
                    >
                      <Check />
                      Archived
                      <Kbd>A</Kbd>
                    </FocusButton>
                  </>
                )}
                <FocusButton onClick={() => later(current)}>
                  <Clock />
                  Later
                  <Kbd>L</Kbd>
                </FocusButton>
              </div>
            </article>

            {rest.length > 0 ? (
              <section aria-label="Up next" className="grid gap-px opacity-60">
                <h2 className="px-2.5 pb-1 text-xs font-semibold text-muted-foreground">Up next</h2>
                {rest.slice(0, 2).map((link) => (
                  <div className="flex h-9 items-center gap-3 px-2.5 text-sm" key={link.id}>
                    <SiteBadge site={link.site} />
                    <LinkText canonicalUrl={link.canonicalUrl} />
                  </div>
                ))}
              </section>
            ) : null}

            <p className="text-center text-xs text-muted-foreground">⌫ removes the link</p>
          </div>
        ) : (
          <div className="grid justify-items-center gap-3 text-center">
            <p className="text-lg font-semibold">Nothing left here</p>
            <p className="text-sm text-muted-foreground">
              {tally.archived > 0 ? `${tally.archived} archived this run.` : "The list is empty."}
            </p>
            <Button onClick={onExit} variant="secondary">
              Back to the list
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function FocusButton({
  children,
  className,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <Button
      className={cn("h-11 rounded-[10px] text-sm", className)}
      onClick={onClick}
      variant={primary ? "default" : "secondary"}
    >
      {children}
    </Button>
  );
}
