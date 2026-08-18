#!/usr/bin/env node
import { executeCommand } from "./commands.js";
import { configFromOptions, createConfigStore } from "./config.js";
import { resolveOptions } from "./options.js";

async function run(): Promise<void> {
  const configStore = createConfigStore();
  const options = await resolveOptions(process.argv.slice(2), { configStore });

  if (!options) {
    return;
  }

  await executeCommand(options);

  if (options.command !== "doctor" || options.source) {
    await configStore.save(configFromOptions(options));
  }
}

run().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
  console.error(error.message);
  process.exit(1);
});
