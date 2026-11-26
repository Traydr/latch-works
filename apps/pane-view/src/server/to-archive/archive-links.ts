import { and, asc, desc, eq, ilike, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { extractUrls, type ParsedLink, parseLink } from "@/features/to-archive/link-sites";
import {
  type AddLinkOutcome,
  type AddLinksResult,
  ARCHIVED_PAGE_SIZE,
  type ArchivedPage,
  type ArchiveLink,
  type ListArchivedInput,
} from "@/features/to-archive/to-archive-contract";
import { type Database, db } from "../db";
import { archiveLinks } from "../db/schema";

/**
 * To archive's storage (plan 068): one row per canonical link, either waiting in To archive or
 * archived. Every function takes the `Database` seam so tests run it against pglite.
 */

type ArchiveLinkRow = typeof archiveLinks.$inferSelect;

export class ArchiveLinkNotFoundError extends Error {
  constructor() {
    super("That link is no longer in the list.");
    this.name = "ArchiveLinkNotFoundError";
  }
}

function toArchiveLink(row: ArchiveLinkRow): ArchiveLink {
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    site: row.site,
    status: row.status,
    queuedAt: row.queuedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    recheckDays: row.recheckDays,
    addedAt: row.addedAt.toISOString(),
  };
}

function requireRow(row: ArchiveLinkRow | undefined): ArchiveLink {
  if (!row) throw new ArchiveLinkNotFoundError();

  return toArchiveLink(row);
}

const recheckDueAt = sql`${archiveLinks.archivedAt} + make_interval(days => ${archiveLinks.recheckDays})`;

/**
 * A queue time behind every link now waiting: the database's clock, or a millisecond after the
 * newest waiting link when that is later. The database decides, so links added, sent back or
 * queued again in the same millisecond, or by a server whose clock runs ahead, still line up.
 */
const backOfQueue = sql`greatest(
  clock_timestamp(),
  (select max(${archiveLinks.queuedAt}) from ${archiveLinks}
    where ${archiveLinks.status} = 'to_archive') + interval '1 millisecond'
)`;

/** Archived links whose recheck has come due go back to To archive, queued at their due date. */
async function requeueDueRechecks(database: Database): Promise<void> {
  await database
    .update(archiveLinks)
    .set({ status: "to_archive", queuedAt: sql`${recheckDueAt}` })
    .where(
      and(
        eq(archiveLinks.status, "archived"),
        isNotNull(archiveLinks.recheckDays),
        lte(recheckDueAt, sql`now()`),
      ),
    );
}

/** Everything in To archive, oldest first (Later sends a link to the back). */
export async function listToArchive(database: Database = db): Promise<ArchiveLink[]> {
  await requeueDueRechecks(database);

  const rows = await database
    .select()
    .from(archiveLinks)
    .where(eq(archiveLinks.status, "to_archive"))
    .orderBy(asc(archiveLinks.queuedAt), asc(archiveLinks.id));

  return rows.map(toArchiveLink);
}

interface ArchivedCursor {
  archivedAt: Date;
  id: string;
}

function encodeCursor(link: ArchiveLink): string {
  return `${link.archivedAt ?? ""}|${link.id}`;
}

function decodeCursor(cursor: string): ArchivedCursor | null {
  const [archivedAt, rawId] = cursor.split("|");
  const date = archivedAt ? new Date(archivedAt) : null;
  const id = z.uuid().safeParse(rawId);

  if (!date || Number.isNaN(date.getTime()) || !id.success) return null;

  return { archivedAt: date, id: id.data };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Archived links, newest first, a page at a time; `search` matches anywhere in the link. */
export async function listArchived(
  { cursor, search }: ListArchivedInput,
  database: Database = db,
): Promise<ArchivedPage> {
  await requeueDueRechecks(database);

  const term = search?.trim();
  const after = cursor ? decodeCursor(cursor) : null;

  const rows = await database
    .select()
    .from(archiveLinks)
    .where(
      and(
        eq(archiveLinks.status, "archived"),
        term ? ilike(archiveLinks.canonicalUrl, `%${escapeLike(term)}%`) : undefined,
        after
          ? or(
              lt(archiveLinks.archivedAt, after.archivedAt),
              and(eq(archiveLinks.archivedAt, after.archivedAt), lt(archiveLinks.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(archiveLinks.archivedAt), desc(archiveLinks.id))
    .limit(ARCHIVED_PAGE_SIZE + 1);

  const links = rows.slice(0, ARCHIVED_PAGE_SIZE).map(toArchiveLink);
  const last = links.at(-1);

  return {
    links,
    nextCursor: rows.length > ARCHIVED_PAGE_SIZE && last ? encodeCursor(last) : null,
  };
}

async function addOne(link: ParsedLink, database: Database): Promise<AddLinkOutcome> {
  const [inserted] = await database
    .insert(archiveLinks)
    .values({
      canonicalUrl: link.canonicalUrl,
      queuedAt: backOfQueue,
      site: link.site,
      url: link.url,
    })
    .onConflictDoNothing({ target: archiveLinks.canonicalUrl })
    .returning();

  if (inserted) return { kind: "added", link: toArchiveLink(inserted) };

  const [existing] = await database
    .select()
    .from(archiveLinks)
    .where(eq(archiveLinks.canonicalUrl, link.canonicalUrl));

  const stored = requireRow(existing);

  return stored.status === "archived"
    ? { kind: "archived", link: stored }
    : { kind: "waiting", link: stored };
}

/**
 * Adds every link in pasted text, in the order pasted, each to the back of To archive. A link
 * already stored is left as it is and reported; one pasted twice counts once.
 */
export async function addLinks(text: string, database: Database = db): Promise<AddLinksResult> {
  const byCanonical = new Map<string, ParsedLink>();
  let skipped = 0;

  for (const candidate of extractUrls(text)) {
    const link = parseLink(candidate);

    if (!link) {
      skipped += 1;
    } else if (!byCanonical.has(link.canonicalUrl)) {
      byCanonical.set(link.canonicalUrl, link);
    }
  }

  const outcomes: AddLinkOutcome[] = [];

  // One at a time, so each link goes behind the one pasted before it.
  for (const link of byCanonical.values()) {
    outcomes.push(await addOne(link, database));
  }

  return { outcomes, skipped };
}

export async function archiveLink(id: string, database: Database = db): Promise<ArchiveLink> {
  const [row] = await database
    .update(archiveLinks)
    // To the millisecond: the Archived cursor carries an ISO time, which has no microseconds.
    .set({ archivedAt: sql`date_trunc('milliseconds', clock_timestamp())`, status: "archived" })
    .where(eq(archiveLinks.id, id))
    .returning();

  return requireRow(row);
}

/** Sends a waiting link to the back of To archive. */
export async function laterLink(id: string, database: Database = db): Promise<ArchiveLink> {
  const [row] = await database
    .update(archiveLinks)
    .set({ queuedAt: backOfQueue })
    .where(and(eq(archiveLinks.id, id), eq(archiveLinks.status, "to_archive")))
    .returning();

  return requireRow(row);
}

/** Puts an archived link back at the back of To archive ("Queue again", "Back to To archive"). */
export async function requeueLink(id: string, database: Database = db): Promise<ArchiveLink> {
  const [row] = await database
    .update(archiveLinks)
    .set({ queuedAt: backOfQueue, status: "to_archive" })
    .where(eq(archiveLinks.id, id))
    .returning();

  return requireRow(row);
}

/** Deletes a link and returns it, so the page can offer Undo. */
export async function removeLink(id: string, database: Database = db): Promise<ArchiveLink> {
  const [row] = await database.delete(archiveLinks).where(eq(archiveLinks.id, id)).returning();

  return requireRow(row);
}

/**
 * Undo: puts a link back exactly as the page last saw it, before an Archived, a Later or a
 * Remove. A removed link is inserted again, unless the same link was added meanwhile.
 */
export async function restoreLink(link: ArchiveLink, database: Database = db): Promise<void> {
  const state = {
    archivedAt: link.archivedAt ? new Date(link.archivedAt) : null,
    queuedAt: new Date(link.queuedAt),
    recheckDays: link.recheckDays,
    status: link.status,
  };

  const [updated] = await database
    .update(archiveLinks)
    .set(state)
    .where(eq(archiveLinks.id, link.id))
    .returning({ id: archiveLinks.id });

  if (updated) return;

  // The page sends the removed row back; its site and key are worked out again from the URL.
  const parsed = parseLink(link.url);

  if (!parsed) throw new Error("That link can't be restored.");

  await database
    .insert(archiveLinks)
    .values({
      addedAt: new Date(link.addedAt),
      archivedAt: link.archivedAt ? new Date(link.archivedAt) : null,
      canonicalUrl: parsed.canonicalUrl,
      id: link.id,
      queuedAt: new Date(link.queuedAt),
      recheckDays: link.recheckDays,
      site: parsed.site,
      status: link.status,
      url: parsed.url,
    })
    .onConflictDoNothing();
}

/** Switches a link's recheck on at `days`, or off with null. */
export async function setRecheck(
  { days, id }: { days: number | null; id: string },
  database: Database = db,
): Promise<ArchiveLink> {
  const [row] = await database
    .update(archiveLinks)
    .set({ recheckDays: days })
    .where(eq(archiveLinks.id, id))
    .returning();

  return requireRow(row);
}
