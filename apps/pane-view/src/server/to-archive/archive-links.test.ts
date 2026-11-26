import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { archiveLinks } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import {
  addLinks,
  archiveLink,
  laterLink,
  listArchived,
  listToArchive,
  removeLink,
  requeueLink,
  restoreLink,
  setRecheck,
} from "./archive-links";

const testDatabase = testDatabaseForSuite();

beforeEach(async () => {
  await testDatabase().db.delete(archiveLinks);
});

async function waitingKeys(): Promise<string[]> {
  return (await listToArchive(testDatabase().db)).map((link) => link.canonicalUrl);
}

async function addOne(url: string) {
  const { outcomes } = await addLinks(url, testDatabase().db);
  const [outcome] = outcomes;

  if (!outcome) throw new Error(`nothing added for ${url}`);

  return outcome.link;
}

describe("addLinks", () => {
  it("adds pasted links in order and counts one written two ways once", async () => {
    const result = await addLinks(
      [
        "https://www.patreon.com/c/inkwellmoth/posts?utm_source=discord",
        "finished https://archiveofourown.org/works/51200417/chapters/129433021",
        "https://patreon.com/inkwellmoth",
        "no link here http://localhost/admin",
      ].join("\n"),
      testDatabase().db,
    );

    expect(result.skipped).toBe(1);
    expect(result.outcomes.map(({ kind, link }) => [kind, link.canonicalUrl, link.site])).toEqual([
      ["added", "patreon.com/inkwellmoth", "patreon"],
      ["added", "archiveofourown.org/works/51200417", "archiveofourown"],
    ]);
    expect(await waitingKeys()).toEqual([
      "patreon.com/inkwellmoth",
      "archiveofourown.org/works/51200417",
    ]);
  });

  it("reports a link already waiting or already archived, and changes neither", async () => {
    const waiting = await addOne("https://danbooru.donmai.us/posts/7712004");
    const done = await addOne("https://ko-fi.com/saltmarshstudio");
    await archiveLink(done.id, testDatabase().db);

    const { outcomes } = await addLinks(
      "https://danbooru.donmai.us/posts/7712004?q=x https://ko-fi.com/SaltmarshStudio/shop",
      testDatabase().db,
    );

    expect(outcomes.map(({ kind, link }) => [kind, link.id])).toEqual([
      ["waiting", waiting.id],
      ["archived", done.id],
    ]);
    expect(await waitingKeys()).toEqual(["danbooru.donmai.us/posts/7712004"]);
  });

  it("adds nothing when the text holds no link", async () => {
    expect(await addLinks("just words", testDatabase().db)).toEqual({ outcomes: [], skipped: 0 });
  });
});

describe("the To archive order", () => {
  it("sends a link to the back with Later and when it is queued again", async () => {
    await addLinks(
      "https://x.com/a/status/1 https://x.com/b/status/2 https://x.com/c/status/3",
      testDatabase().db,
    );
    const [first, second] = await listToArchive(testDatabase().db);

    if (!first || !second) throw new Error("expected three links");

    await laterLink(first.id, testDatabase().db);
    expect(await waitingKeys()).toEqual([
      "x.com/b/status/2",
      "x.com/c/status/3",
      "x.com/a/status/1",
    ]);

    await archiveLink(second.id, testDatabase().db);
    expect(await waitingKeys()).toEqual(["x.com/c/status/3", "x.com/a/status/1"]);

    const requeued = await requeueLink(second.id, testDatabase().db);
    expect(requeued.status).toBe("to_archive");
    expect(await waitingKeys()).toEqual([
      "x.com/c/status/3",
      "x.com/a/status/1",
      "x.com/b/status/2",
    ]);
  });
});

describe("recheck", () => {
  it("brings an archived link back once its interval has passed, and not before", async () => {
    const link = await addOne("https://subscribestar.adult/velvetcartograph");
    await archiveLink(link.id, testDatabase().db);
    await setRecheck({ days: 90, id: link.id }, testDatabase().db);

    await testDatabase()
      .db.update(archiveLinks)
      .set({ archivedAt: sql`now() - interval '89 days'` })
      .where(eq(archiveLinks.id, link.id));
    expect(await waitingKeys()).toEqual([]);

    await testDatabase()
      .db.update(archiveLinks)
      .set({ archivedAt: sql`now() - interval '91 days'` })
      .where(eq(archiveLinks.id, link.id));
    const [due] = await listToArchive(testDatabase().db);

    expect(due).toMatchObject({ id: link.id, recheckDays: 90, status: "to_archive" });
    expect(due?.archivedAt).not.toBeNull();
  });

  it("leaves an archived link alone when recheck is off", async () => {
    const link = await addOne("https://ko-fi.com/saltmarshstudio");
    await archiveLink(link.id, testDatabase().db);
    await testDatabase()
      .db.update(archiveLinks)
      .set({ archivedAt: sql`now() - interval '400 days'` })
      .where(eq(archiveLinks.id, link.id));

    expect(await waitingKeys()).toEqual([]);
  });
});

describe("listArchived", () => {
  it("lists newest first, searches, and pages", async () => {
    const urls = Array.from(
      { length: 103 },
      (_, index) => `https://danbooru.donmai.us/posts/${index + 1}`,
    );

    await addLinks(urls.join("\n"), testDatabase().db);

    for (const link of await listToArchive(testDatabase().db)) {
      await archiveLink(link.id, testDatabase().db);
    }

    const page = await listArchived({}, testDatabase().db);

    expect(page.links).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();

    const rest = await listArchived({ cursor: page.nextCursor ?? "" }, testDatabase().db);
    const seen = new Set([...page.links, ...rest.links].map((link) => link.id));

    expect(rest.links).toHaveLength(3);
    expect(rest.nextCursor).toBeNull();
    expect(seen.size).toBe(103);

    const found = await listArchived({ search: "posts/10" }, testDatabase().db);

    expect(found.links.map((link) => link.canonicalUrl).sort()).toEqual([
      "danbooru.donmai.us/posts/10",
      "danbooru.donmai.us/posts/100",
      "danbooru.donmai.us/posts/101",
      "danbooru.donmai.us/posts/102",
      "danbooru.donmai.us/posts/103",
    ]);
    expect((await listArchived({ search: "100%" }, testDatabase().db)).links).toEqual([]);
  });
});

describe("remove and undo", () => {
  it("brings a removed link back as it was", async () => {
    const link = await addOne("https://www.pixiv.net/en/artworks/120334561");
    const removed = await removeLink(link.id, testDatabase().db);

    expect(await waitingKeys()).toEqual([]);

    await restoreLink(removed, testDatabase().db);
    expect(await listToArchive(testDatabase().db)).toEqual([link]);
  });

  it("undoes Archived and Later, keeping the link's place", async () => {
    await addLinks("https://x.com/a/status/1 https://x.com/b/status/2", testDatabase().db);
    const [first] = await listToArchive(testDatabase().db);

    if (!first) throw new Error("expected two links");

    await archiveLink(first.id, testDatabase().db);
    await restoreLink(first, testDatabase().db);
    expect(await waitingKeys()).toEqual(["x.com/a/status/1", "x.com/b/status/2"]);

    await laterLink(first.id, testDatabase().db);
    await restoreLink(first, testDatabase().db);
    expect(await listToArchive(testDatabase().db).then((links) => links[0])).toEqual(first);
  });
});
