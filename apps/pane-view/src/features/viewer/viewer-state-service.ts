import { createServerFn } from "@tanstack/react-start";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";
import {
  type ViewerStateSnapshot,
  ViewerStateSubjectSchema,
  ViewerStateWriteSchema,
} from "./viewer-state-contract";

export const getViewerState = createServerFn({ method: "GET" })
  .validator(ViewerStateSubjectSchema)
  .handler(async ({ data }): Promise<ViewerStateSnapshot | null> => {
    const userId = await assertWebSessionAuthorized();
    const { readViewerState } = await import("../../server/viewer-state/repository");

    return readViewerState({ subjectId: data.subjectId, userId });
  });

export const saveViewerState = createServerFn({ method: "POST" })
  .validator(ViewerStateWriteSchema)
  .handler(async ({ data }): Promise<void> => {
    const userId = await assertWebSessionAuthorized();
    const { upsertViewerState } = await import("../../server/viewer-state/repository");

    await upsertViewerState({ state: data, userId });
  });
