import { defineConfig } from "drizzle-kit";
import { requireDatabaseUrl } from "./src/server/db/env";

export default defineConfig({
  dbCredentials: {
    url: requireDatabaseUrl(process.env, "drizzle-kit migrate"),
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/server/db/schema.ts",
});
