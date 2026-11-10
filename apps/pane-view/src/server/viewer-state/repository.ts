import { and, eq } from "drizzle-orm";
import type {
  ViewerStateSnapshot,
  ViewerStateWrite,
} from "@/features/viewer/viewer-state-contract";
import { db } from "../db";
import { viewerState } from "../db/schema";

export async function readViewerState({
  subjectId,
  userId,
}: {
  subjectId: string;
  userId: string;
}): Promise<ViewerStateSnapshot | null> {
  const [state] = await db
    .select({ page: viewerState.page, positionMs: viewerState.positionMs })
    .from(viewerState)
    .where(and(eq(viewerState.userId, userId), eq(viewerState.subjectId, subjectId)))
    .limit(1);

  return state
    ? { page: state.page ?? undefined, positionMs: state.positionMs ?? undefined }
    : null;
}

export async function upsertViewerState({
  state,
  userId,
}: {
  state: ViewerStateWrite;
  userId: string;
}): Promise<void> {
  await db
    .insert(viewerState)
    .values({
      page: state.page ?? null,
      positionMs: state.positionMs ?? null,
      subjectId: state.subjectId,
      updatedAt: new Date(),
      userId,
    })
    .onConflictDoUpdate({
      set: {
        page: state.page ?? null,
        positionMs: state.positionMs ?? null,
        updatedAt: new Date(),
      },
      target: [viewerState.userId, viewerState.subjectId],
    });
}
