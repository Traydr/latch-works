import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { viewerState } from "../db/schema";
import type { ViewerStateSnapshot, ViewerStateWrite } from "./types";

export type { ViewerStateSnapshot, ViewerStateWrite } from "./types";

export async function readViewerState({
  subjectId,
  subjectType,
  userId,
}: {
  subjectId: string;
  subjectType: "library_entry" | "collection";
  userId: string;
}): Promise<ViewerStateSnapshot | null> {
  const [state] = await db
    .select()
    .from(viewerState)
    .where(
      and(
        eq(viewerState.userId, userId),
        eq(viewerState.subjectId, subjectId),
        eq(viewerState.subjectType, subjectType),
      ),
    )
    .limit(1);

  return state ? toSnapshot(state) : null;
}

export async function upsertViewerState({
  state,
  userId,
}: {
  state: ViewerStateWrite;
  userId: string;
}): Promise<ViewerStateSnapshot | null> {
  const [saved] = await db
    .insert(viewerState)
    .values({
      page: state.page ?? null,
      positionMs: state.positionMs ?? null,
      subjectId: state.subjectId,
      subjectType: state.subjectType,
      updatedAt: new Date(),
      userId,
    })
    .onConflictDoUpdate({
      set: {
        page: state.page ?? null,
        positionMs: state.positionMs ?? null,
        updatedAt: new Date(),
      },
      target: [viewerState.userId, viewerState.subjectId, viewerState.subjectType],
    })
    .returning();

  return saved ? toSnapshot(saved) : null;
}

function toSnapshot(state: typeof viewerState.$inferSelect): ViewerStateSnapshot {
  return {
    page: state.page ?? undefined,
    positionMs: state.positionMs ?? undefined,
    subjectId: state.subjectId,
    subjectType: state.subjectType,
    updatedAt: state.updatedAt.toISOString(),
  };
}
