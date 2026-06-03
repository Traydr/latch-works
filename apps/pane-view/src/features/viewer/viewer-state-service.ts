import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { readRequestSessionUserId } from "../../server/auth/web-session-core";
import {
  readViewerState,
  upsertViewerState,
  type ViewerStateSnapshot,
} from "../../server/viewer-state/repository";

const viewerStateSubjectSchema = z.object({
  subjectId: z.uuid(),
  subjectType: z.enum(["media"]),
});

const viewerStateWriteSchema = viewerStateSubjectSchema.extend({
  page: z.number().int().positive().optional(),
  positionMs: z.number().int().nonnegative().optional(),
});

export const getViewerState = createServerFn({ method: "GET" })
  .inputValidator(viewerStateSubjectSchema)
  .handler(async ({ data }): Promise<ViewerStateSnapshot | null> => {
    const userId = await readRequestSessionUserId({
      request: getRequest(),
    });

    if (!userId) {
      return null;
    }

    return readViewerState({
      subjectId: data.subjectId,
      subjectType: data.subjectType,
      userId,
    });
  });

export const saveViewerState = createServerFn({ method: "POST" })
  .inputValidator(viewerStateWriteSchema)
  .handler(async ({ data }): Promise<ViewerStateSnapshot | null> => {
    const userId = await readRequestSessionUserId({
      request: getRequest(),
    });

    if (!userId) {
      return null;
    }

    return upsertViewerState({
      state: data,
      userId,
    });
  });

export type { ViewerStateSnapshot };
