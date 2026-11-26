# Plan 068: To archive, a list of links waiting to be archived, in Pane View

> **Executor instructions**: Written 2026-11-26 from two rounds of mockups with the owner
> ([mockups, round 2](https://vellum.traydr.dev/t/3Mc0vNyT5sNbxnvWyhNIaH6FIit), private; round 1
> under `~history`). The owner chose mock G (the page) and mock H (focus mode). They decided:
> desktop only (macOS and Windows laptops, never a phone); links grouped by site only, with no
> "one click / takes a while" split; Later sends a link to the back of the list; the sidebar entry
> is "To archive" with no count; recheck exists but is off unless switched on for a link, at 90
> days by default. They do not want: an importer for old links, anything to do with Discord, a link
> to the library folder, notes or history on a link, a creator ledger, a board, a phone layout, or
> any connection between Gather Box and Pane View. Do not re-ask any of those.
>
> **Drift check (run first)**: `git diff --stat ff01ebac..HEAD -- apps/pane-view/src/server/db
> apps/pane-view/src/features/gallery/ArchiveSidebar.tsx apps/pane-view/src/routes/_authed
> apps/gather-box/src/shared/source-catalog.ts`. If Gather Box gained a source, add its hosts to
> the site table in Step 1.

## Status

- **Status**: IN PROGRESS (2026-11-26), Steps 1–6 built on `agent/068-to-archive`
- **Priority**: P2 (the owner asked for it)
- **Effort**: M
- **Risk**: LOW. One new table and one migration. Nothing touches the library, sync, or Shutter
  tables, and nothing is reachable without a signed-in session. There's no new environment variable
  and no public API.
- **Planned at**: commit `ff01ebac`, 2026-11-26

## Why

The owner keeps links they mean to archive (Patreon, Ko-fi, SubscribeStar, AO3, FanFiction.Net,
Hentai Foundry, Danbooru, pixiv, FANBOX, Kemono and Pawchive pages) in several Discord channels. The
channels only exist to separate quick links from slow ones, and nothing records which links are
done. They want one place to paste a link, go through the links site by site, press Archived, and
know later that a link was already done. Old links stay where they are: only new links go in.

## Decisions

- **Pane View, desktop first.** It already has the database, the sign-in, and both of the owner's
  machines. The page must not break on a phone, but gets no phone design.
- **Two lists.** A link is either in **To archive** or in **Archived**. **Later** keeps it in To
  archive and sends it to the back. **Remove** deletes it, with Undo.
- **Queue order.** To archive is oldest first, by `queued_at`. Adding, Later, "Queue again" and
  "Back to To archive" all set `queued_at` to now, so the link goes to the back.
- **Sites.** Detected from the host alone (table below). Unknown hosts go under **Other sites**.
  The site list in the page shows only sites that have links in the current list.
- **No duplicates.** Links are compared by a canonical URL (rules below). Adding a link already
  waiting says so and adds nothing. Adding one already archived says when, and offers **Queue
  again**.
- **Recheck is opt-in.** In Archived, a link's menu switches on "Recheck every N days" (30, 60,
  90 or 180, default 90). When it's due, the link goes back to To archive with a **recheck** tag.
  Archiving it again restarts the interval.
- **Gather Box is untouched.** The site table lives in Pane View and was seeded from Gather Box's
  source catalog. There's no shared package: without the one-click split, Pane View needs only
  hosts, not Gather Box's page patterns.
- **No titles.** Nothing is fetched from the sites. A row shows the host and path, and focus mode
  shows a label parsed from the URL (a creator handle, "Work 51200417", "Post 7712004").
- **Layout.** A page of its own, like Stats and Manage: "Back to gallery", then the page. The
  mockups draw the gallery sidebar around it; the real page follows the Stats/Manage pattern, and
  the sidebar's link takes you there.

## Sites

| Site key | Label | Hosts |
| --- | --- | --- |
| `archiveofourown` | Archive of Our Own | `archiveofourown.org`, `ao3.org` |
| `fanfiction-net` | FanFiction.Net | `fanfiction.net` |
| `hentaifoundry` | Hentai Foundry | `hentai-foundry.com` |
| `kemono` | Kemono / Pawchive | `kemono.cr`, `kemono.su`, `kemono.party`, `pawchive.pw` |
| `pixiv` | pixiv | `pixiv.net` |
| `fanbox` | pixivFANBOX | `fanbox.cc`, `*.fanbox.cc` |
| `danbooru` | Danbooru | `danbooru.donmai.us` |
| `x` | X | `x.com`, `twitter.com` |
| `reddit` | Reddit | `reddit.com`, `old.reddit.com` |
| `myhentaigallery` | MyHentaiGallery | `myhentaigallery.com` |
| `patreon` | Patreon | `patreon.com` |
| `kofi` | Ko-fi | `ko-fi.com` |
| `subscribestar` | SubscribeStar | `subscribestar.adult`, `subscribestar.com` |
| `other` | Other sites | anything else |

Each site also has a two- or three-letter badge and a colour (as drawn in the mockups). These are
letters, not the sites' logos.

### Canonical URL

Applied in this order:

1. Every link: trim it, require `http:` or `https:` (anything else is refused), lowercase the host,
   drop `www.`, `m.` and `mobile.`, drop the fragment, drop `utm_*`, `ref`, `ref_src`, `fbclid`,
   `igshid` and `si`, sort the remaining query parameters, and drop a trailing slash. The scheme is
   dropped from the key, so `http` and `https` match.
2. Per site:
   - AO3: `/works/N/chapters/M` → `/works/N`, and the query is dropped.
   - FanFiction.Net: `/s/N/…` → `/s/N`.
   - pixiv: a language prefix goes (`/en/artworks/N` → `/artworks/N`).
   - Danbooru: `/posts/N?…` → `/posts/N`.
   - Patreon: `/c/name` and `/name/posts` → `/name`, and `/posts/slug-N` → `/posts/N`.
   - Ko-fi: `/name/shop`, `/name/posts` and similar tabs → `/name`.
   - X: `twitter.com` → `x.com`, and `/status/N/photo/1` → `/status/N`.
   - Reddit: `old.` goes, and `/r/s/comments/id/slug` → `/r/s/comments/id`.
   - Kemono and Pawchive keep their own host. They're mirrors, but either can be missing a post.

`canonical_url` is the key, and `url` keeps what was pasted (for opening).

## Data

One table, `archive_links`, in `apps/pane-view/src/server/db/schema.ts`, plus one Drizzle migration
(`pnpm --filter @latch-works/pane-view db:generate`):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, primary key, random default | |
| `url` | text, not null | As pasted, trimmed |
| `canonical_url` | text, not null, unique | The duplicate key |
| `site` | text, not null | A site key. Text, not an enum, so a new site needs no migration |
| `status` | `archive_link_status` enum: `to_archive`, `archived` | |
| `queued_at` | timestamptz, not null | The To archive order |
| `archived_at` | timestamptz, null | Kept when a link goes back, so the recheck tag can show |
| `recheck_days` | integer, null | Null means no recheck |
| `added_at` | timestamptz, not null, default now | |

Indexes: `(status, queued_at)` and `(status, archived_at desc)`.

A due recheck becomes a real `to_archive` row. The list read first runs
`UPDATE … SET status = 'to_archive', queued_at = archived_at + recheck_days WHERE status =
'archived' AND recheck_days IS NOT NULL AND archived_at + make_interval(days => recheck_days) <=
now()`. Later, Archived and Remove then work the same for every row. The **recheck** tag shows on a
`to_archive` row that has an `archived_at`.

## Steps

1. **Site rules** (`apps/pane-view/src/features/to-archive/link-sites.ts`): pure code, safe in the
   browser. It has the site table, `detectSite(url)`, `canonicalUrl(url)`, `linkLabel(url)` and
   `extractUrls(text)`, which pulls every `http(s)` URL out of pasted text, one or many lines.
   `link-sites.test.ts` pins every rule above with real-shaped URLs. That's parser output, so it's
   committed.
2. **Schema and service** (`apps/pane-view/src/server/to-archive/`): the table and migration, and
   the queries below. Each server function is in `features/to-archive/to-archive-service.ts`,
   calls `assertWebSessionAuthorized()` first, and parses its input with a zod contract in
   `to-archive-contract.ts`:
   - `listToArchive({ site? })` returns the rows oldest first, plus a count per site (after the
     recheck flip).
   - `listArchived({ search?, cursor? })` returns pages of 100, newest first. Search is
     `canonical_url ILIKE`.
   - `addLinks({ text })` returns one outcome per URL: `added`, `waiting` (with `added_at`),
     `archived` (with `archived_at` and `id`) or `invalid`. Repeats inside one paste count once.
   - `archiveLink`, `laterLink`, `requeueLink` (Queue again, and Back to To archive), `removeLink`
     (returns the deleted row), `restoreLink(row)` (Undo), and `setRecheck({ id, days | null })`.
   - The queries go in `to-archive-queries.ts` with TanStack Query keys, like
     `stats-queries.ts`.
3. **The page** (mock G): the route `apps/pane-view/src/routes/_authed/to-archive.tsx`, with search
   params `site` and `tab` (`to-archive` | `archived`) checked by `validateSearch`.
   - **Header:** "Back to gallery", then "To archive" and the To archive / Archived switch.
   - **Paste box:** Enter adds. Pasting several lines adds each. ⌘V or Ctrl+V anywhere on the page
     (outside a text field) adds the clipboard. While typing, a line under the box shows the
     detected site and label, client-side.
   - **Outcomes** (mock L) show in a small bar at the foot of the page, with Undo, Queue again or
     Show. Pane View has no toast library, so build this small bar rather than adding one.
   - **Site column:** All sites, then each site with links, with counts.
   - **Rows:** badge, host (muted) and path, **Open** (`target="_blank" rel="noopener noreferrer"`)
     and **Archived**. Hover adds Later and a menu with Remove. A recheck row has the tag.
   - **Start** above the list begins focus mode on the current site filter.
   - **Archived** (mock K): search, rows grouped by day (Today, Yesterday, then dates), and a row
     menu with Open link, Back to To archive, the recheck switch with its interval, and Remove.
     Use Radix's dropdown menu from `radix-ui` (already a dependency) as a new
     `components/ui/dropdown-menu.tsx`.
4. **Sidebar:** a "To archive" link in `ArchiveSidebar.tsx`'s footer, above Settings, with an
   inbox icon and no count.
5. **Focus mode** (mock H): `?run=1` on the same route, so Back leaves it. It shows one card (badge,
   site, label, URL), a progress line ("3 of 13 · 2 archived") and the next two links.
   - **Keys:** ↵ opens, A archives, L sends it to the back, Backspace removes (with Undo), Esc
     leaves. They work only while focus mode is mounted and no text field has focus, so they
     never reach the gallery hotkeys.
   - **After Open:** when the tab is visible again (`visibilitychange`), the card says "Opened N
     minutes ago" and **Archived** becomes the main button, with "Again" and Later beside it.
   - **Archiving** moves straight to the next card. Undo sits in the foot bar for a few seconds.
   - **The end:** when the list is empty, the run says so and offers the way back to the page.
6. **End-to-end:** `e2e/tests/pane-view/to-archive.spec.ts` covers pasting three links (two of
   them the same link written differently), checking that two rows were added, archiving one, and
   checking that both lists and the "already archived" outcome are right when it's pasted again.

## Verification

- `pnpm --filter @latch-works/pane-view test` (the link-sites suite first), then `pnpm test` and
  `pnpm typecheck`.
- `pnpm lint:all` and `pnpm format`.
- `pnpm e2e:pane` with the new spec (see `docs/runbooks/e2e.md`).
- By hand at desktop width, in light and dark: paste a run of links with tracking parameters, do a
  focus run with only the keyboard, switch on a recheck, set `archived_at` back 91 days in the
  database, and check that the link comes back tagged.
- The PR calls out the migration.

## Out of scope

Importing old links, Discord in any form, Gather Box knowing about the list, the library folder a
link went to, notes, history, titles fetched from the sites, a phone layout, and a count in the
sidebar.
