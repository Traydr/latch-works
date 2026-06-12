#!/usr/bin/env node
import { configFromOptions, createConfigStore } from "./config.js";
import { executeCommand } from "./commands.js";
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

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
