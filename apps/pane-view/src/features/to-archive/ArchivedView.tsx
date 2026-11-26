import { ExternalLink, MoreHorizontal, RefreshCw, Search, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  dayKey,
  formatDayHeading,
  formatShortDate,
  formatTimeOfDay,
  recheckDueDate,
} from "./link-dates";
import { LinkText, SiteBadge, Tag } from "./link-parts";
import { type ArchiveLink, DEFAULT_RECHECK_DAYS, RECHECK_DAY_CHOICES } from "./to-archive-contract";
import { useArchivedQuery } from "./to-archive-queries";
import type { LinkCommands } from "./use-link-commands";

const SEARCH_DEBOUNCE_MS = 250;

interface DayGroup {
  key: number;
  heading: string;
  links: ArchiveLink[];
}

function groupByDay(links: readonly ArchiveLink[]): DayGroup[] {
  const groups: DayGroup[] = [];

  for (const link of links) {
    const archivedAt = new Date(link.archivedAt ?? link.queuedAt);
    const key = dayKey(archivedAt);
    const last = groups.at(-1);

    if (last?.key === key) {
      last.links.push(link);
    } else {
      groups.push({ heading: formatDayHeading(archivedAt), key, links: [link] });
    }
  }

  return groups;
}

function RecheckTag({ link }: { link: ArchiveLink }) {
  if (link.recheckDays === null || link.archivedAt === null) return null;

  const due = recheckDueDate(new Date(link.archivedAt), link.recheckDays);

  return (
    <Tag>
      ↻ {link.recheckDays} d · next {formatShortDate(due)}
    </Tag>
  );
}

function ArchivedRow({ commands, link }: { commands: LinkCommands; link: ArchiveLink }) {
  const archivedAt = new Date(link.archivedAt ?? link.queuedAt);

  return (
    <li className="group grid h-10 grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg pr-1.5 pl-2.5 text-sm hover:bg-accent">
      <SiteBadge site={link.site} />
      <span className="flex min-w-0 items-center">
        <LinkText canonicalUrl={link.canonicalUrl} />
        <RecheckTag link={link} />
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More"
            className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
            size="icon-sm"
            variant="ghost"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem asChild>
            <a href={link.url} rel="noopener noreferrer" target="_blank">
              <ExternalLink />
              Open link
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => commands.queueAgain(link)}>
            <Undo2 />
            Back to To archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={link.recheckDays !== null}
            onCheckedChange={(checked) =>
              commands.setRecheck(link, checked ? DEFAULT_RECHECK_DAYS : null)
            }
            onSelect={(event) => event.preventDefault()}
          >
            <RefreshCw />
            <span className="flex-1">
              Recheck every {link.recheckDays ?? DEFAULT_RECHECK_DAYS} days
            </span>
            <span
              aria-hidden="true"
              className="relative h-4 w-7 rounded-full bg-secondary transition-colors data-[on=true]:bg-primary"
              data-on={link.recheckDays !== null}
            >
              <span
                className="absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow transition-transform data-[on=true]:translate-x-3"
                data-on={link.recheckDays !== null}
              />
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuLabel className="pl-8">Interval</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) => commands.setRecheck(link, Number(value))}
            value={link.recheckDays === null ? "" : String(link.recheckDays)}
          >
            {RECHECK_DAY_CHOICES.map((days) => (
              <DropdownMenuRadioItem key={days} value={String(days)}>
                Every {days} days
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => commands.remove(link)} variant="destructive">
            <Trash2 />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="min-w-12 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {formatTimeOfDay(archivedAt)}
      </span>
    </li>
  );
}

export function ArchivedView({ commands }: { commands: LinkCommands }) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const query = useArchivedQuery(search);
  const links = query.data?.pages.flatMap((page) => page.links) ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(input.trim()), SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [input]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      <label className="mb-2 flex h-11 items-center gap-2.5 rounded-xl bg-card px-3.5 shadow-surface focus-within:ring-3 focus-within:ring-ring/50">
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">Search archived links</span>
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search archived links"
          spellCheck={false}
          type="search"
          value={input}
        />
      </label>

      {query.error ? (
        <p className="px-2.5 text-sm text-destructive">{query.error.message}</p>
      ) : null}

      {groupByDay(links).map((group) => (
        <section aria-label={group.heading} className="grid gap-px" key={group.key}>
          <h2 className="mt-3 mb-1 px-2.5 text-xs font-semibold text-muted-foreground">
            {group.heading}
          </h2>
          <ul className="grid gap-px">
            {group.links.map((link) => (
              <ArchivedRow commands={commands} key={link.id} link={link} />
            ))}
          </ul>
        </section>
      ))}

      {links.length === 0 && !query.isLoading ? (
        <p className="px-2.5 py-10 text-center text-sm text-muted-foreground">
          {search ? "No archived link matches." : "Nothing archived yet."}
        </p>
      ) : null}

      {query.hasNextPage ? (
        <Button
          className="mx-auto mt-4"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          variant="secondary"
        >
          {query.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
