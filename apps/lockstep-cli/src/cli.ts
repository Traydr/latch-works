#!/usr/bin/env node
import { executeCommand } from "./commands.js";
import { createConfigStore } from "./config.js";
import { resolveOptions } from "./options.js";

async function run(): Promise<void> {
  const configStore = createConfigStore();
  const resolved = await resolveOptions(process.argv.slice(2), { configStore });

  if (!resolved) {
    return;
  }

  await executeCommand(resolved.options);
  await configStore.remember(resolved.remember);
}

run().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
  console.error(error.message);
  process.exit(1);
});
