import { z } from "zod";

/** Where the owner left off in one library entry: a video position or a PDF page. */
export const ViewerStateSubjectSchema = z.object({ subjectId: z.uuid() });

export const ViewerStateWriteSchema = ViewerStateSubjectSchema.extend({
  page: z.number().int().positive().optional(),
  positionMs: z.number().int().nonnegative().optional(),
});

export type ViewerStateWrite = z.infer<typeof ViewerStateWriteSchema>;

export type ViewerStateSnapshot = Pick<ViewerStateWrite, "page" | "positionMs">;
