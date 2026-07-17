import { Result } from "better-result";
import type { BrowserWindow } from "electron";
import { dialog, ipcMain } from "electron";
import type { ZodType } from "zod";

import { serializeIpcResult } from "../../shared/ipc";
import { InvokeIpcContractList, InvokeIpcContracts } from "../../shared/ipcContracts";
import { parseWithSchema, RunError, serializeAppResult, ValidationError } from "../errors";
import type { ProfileService } from "../services/profileService";
import type { RunService } from "../services/runService";

function okResult<T>(value: T) {
  return serializeIpcResult(Result.ok(value));
}

function validationFailure(operation: string, message: string) {
  return serializeAppResult(
    Result.err(
      new ValidationError({
        operation,
        message,
      }),
    ),
  );
}

function operationalFailure(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return serializeAppResult(
    Result.err(
      new RunError({
        operation,
        message,
      }),
    ),
  );
}

function validateIpcInput<T>(
  schema: ZodType<T>,
  input: unknown,
  channel: string,
): { ok: true; value: T } | { ok: false; serialized: ReturnType<typeof serializeAppResult> } {
  const parsed = parseWithSchema(schema, input, channel);
  if (Result.isError(parsed)) {
    return { ok: false, serialized: serializeAppResult(Result.err(parsed.error)) };
  }

  return { ok: true, value: parsed.value };
}

function requireRequestSchema<T>(schema: ZodType<T> | null): ZodType<T> {
  if (!schema) {
    throw new Error("IPC request schema is not defined for this channel");
  }

  return schema;
}

export function registerIpc(
  mainWindow: BrowserWindow,
  profileService: ProfileService,
  runService: RunService,
): void {
  for (const contract of InvokeIpcContractList) {
    ipcMain.removeHandler(contract.channel);
  }

  ipcMain.handle(InvokeIpcContracts.getSettings.channel, async () => {
    return okResult(profileService.getSettings());
  });

  ipcMain.handle(InvokeIpcContracts.pickSourceFolder.channel, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Select archive folder",
    });

    if (canceled || filePaths.length === 0) {
      return okResult<string | null>(null);
    }

    return okResult(filePaths[0] ?? null);
  });

  ipcMain.handle(InvokeIpcContracts.createProfile.channel, async (_event, input) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.createProfile.requestSchema),
      input,
      InvokeIpcContracts.createProfile.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    const result = await profileService.createProfile(validated.value);
    return serializeAppResult(result);
  });

  ipcMain.handle(InvokeIpcContracts.updateProfile.channel, async (_event, profileId, patch) => {
    if (typeof profileId !== "string") {
      return validationFailure(InvokeIpcContracts.updateProfile.channel, "Profile id is required.");
    }

    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.updateProfile.requestSchema),
      patch,
      InvokeIpcContracts.updateProfile.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    const result = await profileService.updateProfile(profileId, validated.value);
    return serializeAppResult(result);
  });

  ipcMain.handle(InvokeIpcContracts.deleteProfile.channel, async (_event, profileId) => {
    if (typeof profileId !== "string") {
      return validationFailure(InvokeIpcContracts.deleteProfile.channel, "Profile id is required.");
    }

    const result = await profileService.deleteProfile(profileId);
    return serializeAppResult(result);
  });

  ipcMain.handle(InvokeIpcContracts.setActiveProfile.channel, async (_event, profileId) => {
    if (typeof profileId !== "string") {
      return validationFailure(
        InvokeIpcContracts.setActiveProfile.channel,
        "Profile id is required.",
      );
    }

    const result = await profileService.setActiveProfile(profileId);
    return serializeAppResult(result);
  });

  ipcMain.handle(InvokeIpcContracts.doctor.channel, async (_event, profileId) => {
    if (typeof profileId !== "string") {
      return validationFailure(InvokeIpcContracts.doctor.channel, "Profile id is required.");
    }

    try {
      const result = await runService.doctor(profileId);
      return okResult(result);
    } catch (error) {
      return operationalFailure(InvokeIpcContracts.doctor.channel, error);
    }
  });

  ipcMain.handle(InvokeIpcContracts.plan.channel, async (_event, request) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.plan.requestSchema),
      request,
      InvokeIpcContracts.plan.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    try {
      const plan = await runService.plan(validated.value);
      return okResult(plan);
    } catch (error) {
      return operationalFailure(InvokeIpcContracts.plan.channel, error);
    }
  });

  ipcMain.handle(InvokeIpcContracts.push.channel, async (_event, request) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.push.requestSchema),
      request,
      InvokeIpcContracts.push.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    try {
      const summary = await runService.push(validated.value);
      return okResult(summary);
    } catch (error) {
      return operationalFailure(InvokeIpcContracts.push.channel, error);
    }
  });

  ipcMain.handle(InvokeIpcContracts.prune.channel, async (_event, request) => {
    const validated = validateIpcInput(
      requireRequestSchema(InvokeIpcContracts.prune.requestSchema),
      request,
      InvokeIpcContracts.prune.channel,
    );
    if (!validated.ok) {
      return validated.serialized;
    }

    try {
      const summary = await runService.prune(validated.value);
      return okResult(summary);
    } catch (error) {
      return operationalFailure(InvokeIpcContracts.prune.channel, error);
    }
  });

  ipcMain.handle(InvokeIpcContracts.cancelRun.channel, async () => {
    runService.cancel();
    return okResult(undefined);
  });
}
