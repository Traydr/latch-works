import { Check, Clock, ExternalLink, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LinkText, SiteBadge, Tag } from "./link-parts";
import { extractUrls, parseLink, siteByKey, siteOrder } from "./link-sites";
import { type ArchiveLink, isRecheck } from "./to-archive-contract";
import type { LinkCommands } from "./use-link-commands";

/** "All sites" in the site column. */
export const ALL_SITES = "all";

interface SiteCount {
  site: string;
  count: number;
}

/** The sites that have links waiting, in the site table's order. */
export function countSites(links: readonly ArchiveLink[]): SiteCount[] {
  const counts = new Map<string, number>();

  for (const link of links) counts.set(link.site, (counts.get(link.site) ?? 0) + 1);

  return [...counts]
    .map(([site, count]) => ({ count, site }))
    .sort((a, b) => siteOrder(a.site) - siteOrder(b.site));
}

function PasteBox({ commands }: { commands: LinkCommands }) {
  const [text, setText] = useState("");
  const urls = extractUrls(text);
  const [first] = urls;
  const single = urls.length === 1 && first ? parseLink(first) : null;

  const add = (value: string) => {
    if (value.trim().length === 0) return;

    // Clear the box only if it still holds what was added, not what was typed since.
    commands.add(value, { onDone: () => setText((current) => (current === value ? "" : current)) });
  };

  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        add(text);
      }}
    >
      <label className="flex h-11 items-center gap-2.5 rounded-xl bg-card pr-1.5 pl-3.5 shadow-surface focus-within:ring-3 focus-within:ring-ring/50">
        <Plus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">Add a link</span>
        <input
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          name="link"
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");

            // A paste that holds links adds them straight away; anything else just fills the box.
            if (extractUrls(pasted).length > 0) {
              event.preventDefault();
              add(pasted);
            }
          }}
          placeholder="Paste a link"
          spellCheck={false}
          value={text}
        />
        {text.trim() ? (
          <Button disabled={commands.isAdding} size="sm" type="submit">
            Add
          </Button>
        ) : (
          <kbd className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            ⌘V
          </kbd>
        )}
      </label>
      {text.trim() ? (
        <p className="flex min-h-5 items-center gap-2 px-1 text-[13px] text-muted-foreground">
          {single ? (
            <>
              <SiteBadge site={single.site} />
              <span className="text-foreground">{siteByKey(single.site).label}</span>
              <span>· {single.label}</span>
            </>
          ) : urls.length > 1 ? (
            `${urls.length} links`
          ) : (
            "Not a link yet"
          )}
          {urls.length > 0 ? <span className="ml-auto">↵ add</span> : null}
        </p>
      ) : null}
    </form>
  );
}

function WaitingRow({
  commands,
  highlighted,
  link,
}: {
  commands: LinkCommands;
  highlighted: boolean;
  link: ArchiveLink;
}) {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  return (
    <li
      className={cn(
        "group grid h-11 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg pr-1.5 pl-2.5 text-sm hover:bg-accent",
        highlighted && "bg-selected",
      )}
      ref={ref}
    >
      <SiteBadge site={link.site} />
      <span className="flex min-w-0 items-center">
        <LinkText canonicalUrl={link.canonicalUrl} />
        {isRecheck(link) ? <Tag tone="warning">recheck</Tag> : null}
      </span>
      <span className="flex items-center gap-1">
        <span className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          <Button
            aria-label="Later"
            onClick={() => commands.later(link)}
            size="icon-sm"
            title="Later: send to the back"
            variant="ghost"
          >
            <Clock />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="More" size="icon-sm" variant="ghost">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => commands.remove(link)} variant="destructive">
                <Trash2 />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <Button asChild size="sm" variant="outline">
          <a href={link.url} rel="noopener noreferrer" target="_blank">
            <ExternalLink />
            Open
          </a>
        </Button>
        <Button
          className="text-success"
          onClick={() => commands.archive(link)}
          size="sm"
          variant="outline"
        >
          <Check />
          Archived
        </Button>
      </span>
    </li>
  );
}

export function WaitingView({
  commands,
  highlightId,
  isLoading,
  links,
  onSiteChange,
  onStart,
  site,
}: {
  commands: LinkCommands;
  highlightId: string | null;
  isLoading: boolean;
  links: readonly ArchiveLink[];
  onSiteChange: (site: string) => void;
  onStart: () => void;
  site: string;
}) {
  const sites = countSites(links);
  const shown = site === ALL_SITES ? links : links.filter((link) => link.site === site);
  const heading = site === ALL_SITES ? "All sites" : siteByKey(site).label;

  return (
    <div className="grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="Sites" className="flex flex-col gap-px md:sticky md:top-6 md:self-start">
        <SiteButton
          count={links.length}
          label="All sites"
          on={site === ALL_SITES}
          onClick={() => onSiteChange(ALL_SITES)}
        />
        {sites.length > 0 ? <div className="mx-2.5 my-2 h-px bg-border" /> : null}
        {sites.map((entry) => (
          <SiteButton
            count={entry.count}
            key={entry.site}
            label={siteByKey(entry.site).label}
            on={site === entry.site}
            onClick={() => onSiteChange(entry.site)}
            site={entry.site}
          />
        ))}
      </nav>

      <div className="flex min-w-0 flex-col gap-5">
        <PasteBox commands={commands} />

        <section aria-label={heading} className="grid gap-1">
          <div className="flex items-center gap-2 px-2.5 text-xs font-semibold text-muted-foreground">
            {heading}
            <span className="font-normal tabular-nums">{shown.length}</span>
            <Button
              className="ml-auto"
              disabled={shown.length === 0}
              onClick={onStart}
              size="sm"
              variant="secondary"
            >
              <Play />
              Start
            </Button>
          </div>
          {shown.length > 0 ? (
            <ul className="grid gap-px">
              {shown.map((link) => (
                <WaitingRow
                  commands={commands}
                  highlighted={link.id === highlightId}
                  key={link.id}
                  link={link}
                />
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-10 text-center text-sm text-muted-foreground">
              {isLoading ? "Loading…" : "Nothing waiting. Paste a link to add one."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function SiteButton({
  count,
  label,
  on,
  onClick,
  site,
}: {
  count: number;
  label: string;
  on: boolean;
  onClick: () => void;
  site?: string;
}) {
  return (
    <button
      aria-current={on ? "true" : undefined}
      className={cn(
        "touch-target flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground",
        on && "bg-selected font-semibold text-foreground hover:bg-selected",
      )}
      onClick={onClick}
      type="button"
    >
      {site ? <SiteBadge className="size-4.5 text-[7.5px]" site={site} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs font-normal tabular-nums">{count}</span>
    </button>
  );
}
