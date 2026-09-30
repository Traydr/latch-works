#!/usr/bin/env node
import { UnfinalizedSyncRunError } from "@latch-works/lockstep-core";
import { executeCommand } from "./commands.js";
import { createConfigStore } from "./config.js";
import { watchInterrupts } from "./interrupt.js";
import { resolveOptions } from "./options.js";

async function run(): Promise<void> {
  const configStore = createConfigStore();
  const resolved = await resolveOptions(process.argv.slice(2), { configStore });

  if (!resolved) {
    return;
  }

  const interrupts = watchInterrupts();

  try {
    await executeCommand(resolved.options, { signal: interrupts.signal });
  } catch (error) {
    const exitCode = interrupts.exitCode();

    if (exitCode === undefined) {
      throw error;
    }

    // Finalization failed, so Pane View still shows the run as running: the message names the run
    // and how to cancel it, which a bare "Cancelled." would hide. Only a run that was meant to
    // end as cancelled keeps the signal's exit code.
    if (error instanceof UnfinalizedSyncRunError) {
      console.error(error.message);
      process.exitCode = error.intendedStatus === "cancelled" ? exitCode : 1;

      return;
    }

    console.error("Cancelled.");
    process.exitCode = exitCode;

    return;
  } finally {
    interrupts.stop();
  }

  // A signal can land after the last request (while push or prune awaits its finalization, or
  // while doctor runs its checks): the result printed above stands, but the exit code still
  // reports the interrupt and the settings are not remembered, as for any cancelled command.
  const exitCode = interrupts.exitCode();

  if (exitCode !== undefined) {
    console.error("Interrupted after the command finished; the result above stands.");
    process.exitCode = exitCode;

    return;
  }

  await configStore.remember(resolved.remember);
}

run().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
  console.error(error.message);
  process.exit(1);
});
