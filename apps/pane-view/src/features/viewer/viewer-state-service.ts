import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ViewerStateSnapshot } from "../../server/viewer-state/types";

const viewerStateSubjectSchema = z.object({
  subjectId: z.uuid(),
  subjectType: z.enum(["library_entry"]),
});

const viewerStateWriteSchema = viewerStateSubjectSchema.extend({
  page: z.number().int().positive().optional(),
  positionMs: z.number().int().nonnegative().optional(),
});

export const getViewerState = createServerFn({ method: "GET" })
  .inputValidator(viewerStateSubjectSchema)
  .handler(async ({ data }): Promise<ViewerStateSnapshot | null> => {
    const [{ readRequestSessionUserId }, { getRequest }, { readViewerState }] = await Promise.all([
      import("../../server/auth/web-session-core"),
      import("@tanstack/react-start/server"),
      import("../../server/viewer-state/repository"),
    ]);

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
    const [{ readRequestSessionUserId }, { getRequest }, { upsertViewerState }] = await Promise.all(
      [
        import("../../server/auth/web-session-core"),
        import("@tanstack/react-start/server"),
        import("../../server/viewer-state/repository"),
      ],
    );

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
