import { and, eq } from "drizzle-orm";
import { createPaneViewDb, readDatabaseUrl } from "../db/client";
import { viewerState } from "../db/schema";

export interface ViewerStateSnapshot {
  page?: number;
  positionMs?: number;
  subjectId: string;
  subjectType: string;
  updatedAt: string;
}

export interface ViewerStateWrite {
  page?: number;
  positionMs?: number;
  subjectId: string;
  subjectType: string;
}

export async function readViewerState({
  env,
  subjectId,
  subjectType,
  userId,
}: {
  env: NodeJS.ProcessEnv;
  subjectId: string;
  subjectType: string;
  userId: string;
}): Promise<ViewerStateSnapshot | null> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  const db = createPaneViewDb(databaseUrl);
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
  env,
  state,
  userId,
}: {
  env: NodeJS.ProcessEnv;
  state: ViewerStateWrite;
  userId: string;
}): Promise<ViewerStateSnapshot | null> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  const db = createPaneViewDb(databaseUrl);
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
