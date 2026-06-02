import type { Config } from "drizzle-kit";

import { env } from "./src/env/server";

export default {
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  out: "./drizzle",
  schema: "./src/server/db/schema.ts",
} satisfies Config;
