import { z } from "zod";

/**
 * What To archive's server functions and page share (plan 068). Environment-neutral.
 */

export const ARCHIVE_LINK_STATUSES = ["to_archive", "archived"] as const;

/** The intervals a recheck can be set to, in days; the switch turns one on at the default. */
export const RECHECK_DAY_CHOICES = [30, 60, 90, 180] as const;

export const DEFAULT_RECHECK_DAYS = 90;

export const ARCHIVED_PAGE_SIZE = 100;

export const ArchiveLinkSchema = z.object({
  id: z.uuid(),
  url: z.string().min(1),
  canonicalUrl: z.string().min(1),
  site: z.string().min(1),
  status: z.enum(ARCHIVE_LINK_STATUSES),
  /** ISO timestamps. */
  queuedAt: z.iso.datetime({ offset: true }),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  recheckDays: z.number().int().positive().nullable(),
  addedAt: z.iso.datetime({ offset: true }),
});

export type ArchiveLink = z.infer<typeof ArchiveLinkSchema>;

/** What became of one pasted link. */
export type AddLinkOutcome =
  | { kind: "added"; link: ArchiveLink }
  /** Already in To archive; nothing changed. */
  | { kind: "waiting"; link: ArchiveLink }
  /** Already archived; nothing changed until the owner queues it again. */
  | { kind: "archived"; link: ArchiveLink };

export interface AddLinksResult {
  outcomes: AddLinkOutcome[];
  /** True when the text held no http(s) link at all. */
  nothingFound: boolean;
}

export interface ArchivedPage {
  links: ArchiveLink[];
  nextCursor: string | null;
}

export const AddLinksInputSchema = z.object({ text: z.string().min(1).max(200_000) });

export const LinkIdInputSchema = z.object({ id: z.uuid() });

export const ListArchivedInputSchema = z.object({
  search: z.string().max(500).optional(),
  cursor: z.string().max(200).optional(),
});

export type ListArchivedInput = z.infer<typeof ListArchivedInputSchema>;

export const SetRecheckInputSchema = z.object({
  id: z.uuid(),
  days: z.number().int().positive().max(3650).nullable(),
});

/** A link is a recheck when it waits in To archive after having been archived before. */
export function isRecheck(link: ArchiveLink): boolean {
  return link.status === "to_archive" && link.archivedAt !== null;
}
