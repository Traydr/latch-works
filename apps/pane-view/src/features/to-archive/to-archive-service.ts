import { createServerFn } from "@tanstack/react-start";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";
import {
  AddLinksInputSchema,
  type AddLinksResult,
  type ArchivedPage,
  type ArchiveLink,
  ArchiveLinkSchema,
  LinkIdInputSchema,
  ListArchivedInputSchema,
  SetRecheckInputSchema,
} from "./to-archive-contract";

/*
 * To archive's server functions (plan 068). Server modules load lazily, so this file stays out
 * of the client bundle's server graph.
 */

async function storage() {
  return import("../../server/to-archive/archive-links");
}

export const getToArchive = createServerFn({ method: "GET" }).handler(
  async (): Promise<ArchiveLink[]> => {
    await assertWebSessionAuthorized();

    return (await storage()).listToArchive();
  },
);

export const getArchived = createServerFn({ method: "GET" })
  .validator(ListArchivedInputSchema)
  .handler(async ({ data }): Promise<ArchivedPage> => {
    await assertWebSessionAuthorized();

    return (await storage()).listArchived(data);
  });

export const addArchiveLinks = createServerFn({ method: "POST" })
  .validator(AddLinksInputSchema)
  .handler(async ({ data }): Promise<AddLinksResult> => {
    await assertWebSessionAuthorized();

    return (await storage()).addLinks(data.text);
  });

export const markLinkArchived = createServerFn({ method: "POST" })
  .validator(LinkIdInputSchema)
  .handler(async ({ data }): Promise<ArchiveLink> => {
    await assertWebSessionAuthorized();

    return (await storage()).archiveLink(data.id);
  });

export const sendLinkToBack = createServerFn({ method: "POST" })
  .validator(LinkIdInputSchema)
  .handler(async ({ data }): Promise<ArchiveLink> => {
    await assertWebSessionAuthorized();

    return (await storage()).laterLink(data.id);
  });

export const queueLinkAgain = createServerFn({ method: "POST" })
  .validator(LinkIdInputSchema)
  .handler(async ({ data }): Promise<ArchiveLink> => {
    await assertWebSessionAuthorized();

    return (await storage()).requeueLink(data.id);
  });

export const removeArchiveLink = createServerFn({ method: "POST" })
  .validator(LinkIdInputSchema)
  .handler(async ({ data }): Promise<ArchiveLink> => {
    await assertWebSessionAuthorized();

    return (await storage()).removeLink(data.id);
  });

export const restoreArchiveLink = createServerFn({ method: "POST" })
  .validator(ArchiveLinkSchema)
  .handler(async ({ data }): Promise<void> => {
    await assertWebSessionAuthorized();

    await (await storage()).restoreLink(data);
  });

export const setLinkRecheck = createServerFn({ method: "POST" })
  .validator(SetRecheckInputSchema)
  .handler(async ({ data }): Promise<ArchiveLink> => {
    await assertWebSessionAuthorized();

    return (await storage()).setRecheck(data);
  });
