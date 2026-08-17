import { type GallerySortMode, GallerySortModeSchema } from "@latch-works/media-domain";
import { Archive, Search } from "lucide-react";
import { type FormEvent, Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const sortModes: GallerySortMode[] = [
  "name-asc",
  "name-desc",
  "date-newest",
  "date-oldest",
  "random",
];

const sortLabels = {
  "date-newest": "Newest",
  "date-oldest": "Oldest",
  "name-asc": "A-Z",
  "name-desc": "Z-A",
  random: "Random",
} satisfies Record<GallerySortMode, string>;

interface BrowserHeaderProps {
  archiveRoot: string;
  breadcrumbs: Array<{ label: string; path: string }>;
  entryCount: number;
  onNavigateToPath: (path: string) => void;
  onSearch: (query: string) => void;
  onSortChange: (mode: GallerySortMode) => void;
  searchDraft: string;
  sortMode: GallerySortMode;
}

export function BrowserHeader({
  archiveRoot,
  breadcrumbs,
  entryCount,
  onNavigateToPath,
  onSearch,
  onSortChange,
  searchDraft,
  sortMode,
}: BrowserHeaderProps) {
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch(searchDraft.trim());
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5">
      <Breadcrumb className="flex min-w-0 items-center gap-2">
        <Archive className="size-4 shrink-0 text-muted-foreground" />
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button
                className="max-w-40 cursor-pointer truncate rounded-md px-2 py-1.5"
                onClick={() => onNavigateToPath("")}
                type="button"
              >
                {archiveRoot}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                {index === breadcrumbs.length - 1 ? (
                  <BreadcrumbPage className="max-w-72 truncate" title={crumb.path}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      className="max-w-40 cursor-pointer truncate rounded-md px-2 py-1.5"
                      onClick={() => onNavigateToPath(crumb.path)}
                      title={crumb.path}
                      type="button"
                    >
                      {crumb.label}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <form className="relative hidden w-72 shrink-0 items-center md:flex" onSubmit={submitSearch}>
        <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label="Search archive"
          className="pl-8"
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search paths"
          type="search"
          value={searchDraft}
        />
      </form>

      <div className="flex items-center gap-3">
        <p className="m-0 hidden min-w-0 truncate text-sm text-muted-foreground sm:block">
          <span className="font-medium text-foreground">{entryCount}</span> entries
        </p>
        <Select
          onValueChange={(value) => onSortChange(GallerySortModeSchema.parse(value))}
          value={sortMode}
        >
          <SelectTrigger aria-label="Sort mode" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortModes.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {sortLabels[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </header>
  );
}
