import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const docs = defineCollection({
  loader: glob({ base: "./src/content/docs", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    section: z.string(),
    sectionOrder: z.number(),
    order: z.number(),
    navTitle: z.string().optional(),
  }),
});

export const collections = { docs };
