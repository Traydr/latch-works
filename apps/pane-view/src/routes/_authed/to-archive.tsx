import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ToArchivePage } from "@/features/to-archive/ToArchivePage";

const ToArchiveSearchSchema = z.object({
  tab: z.enum(["to-archive", "archived"]).optional().catch(undefined),
  site: z.string().max(64).optional().catch(undefined),
  run: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_authed/to-archive")({
  validateSearch: ToArchiveSearchSchema,
  component: ToArchivePage,
});
