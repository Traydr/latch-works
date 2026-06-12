import { z } from "zod";

import {
  DoctorResultSchema,
  LockstepPlanSchema,
  LockstepProfileInputSchema,
  LockstepProfilePatchSchema,
  LockstepProfilePublicSchema,
  LockstepRunSummarySchema,
  LockstepSettingsSchema,
  RunRequestSchema,
} from "./contracts";

const VoidSchema = z.undefined();

function defineInvokeContract<
  const TChannel extends string,
  TArgs extends z.ZodTuple,
  TResponse,
  TRequest = never,
>(
  channel: TChannel,
  argsSchema: TArgs,
  responseSchema: z.ZodType<TResponse>,
  requestSchema: z.ZodType<TRequest> | null = null,
) {
  return {
    argsSchema,
    channel,
    requestSchema,
    responseSchema,
  };
}

export const InvokeIpcContracts = {
  cancelRun: defineInvokeContract("lockstep:cancel-run", z.tuple([]), VoidSchema),
  createProfile: defineInvokeContract(
    "lockstep:create-profile",
    z.tuple([LockstepProfileInputSchema]),
    LockstepProfilePublicSchema,
    LockstepProfileInputSchema,
  ),
  deleteProfile: defineInvokeContract(
    "lockstep:delete-profile",
    z.tuple([z.string()]),
    LockstepSettingsSchema,
  ),
  doctor: defineInvokeContract("lockstep:doctor", z.tuple([z.string()]), DoctorResultSchema),
  getSettings: defineInvokeContract("lockstep:get-settings", z.tuple([]), LockstepSettingsSchema),
  pickSourceFolder: defineInvokeContract(
    "lockstep:pick-source-folder",
    z.tuple([]),
    z.string().nullable(),
  ),
  plan: defineInvokeContract(
    "lockstep:plan",
    z.tuple([RunRequestSchema]),
    LockstepPlanSchema,
    RunRequestSchema,
  ),
  prune: defineInvokeContract(
    "lockstep:prune",
    z.tuple([RunRequestSchema]),
    LockstepRunSummarySchema,
    RunRequestSchema,
  ),
  push: defineInvokeContract(
    "lockstep:push",
    z.tuple([RunRequestSchema]),
    LockstepRunSummarySchema,
    RunRequestSchema,
  ),
  setActiveProfile: defineInvokeContract(
    "lockstep:set-active-profile",
    z.tuple([z.string()]),
    LockstepSettingsSchema,
  ),
  updateProfile: defineInvokeContract(
    "lockstep:update-profile",
    z.tuple([z.string(), LockstepProfilePatchSchema]),
    LockstepProfilePublicSchema,
    LockstepProfilePatchSchema,
  ),
} as const;

export const InvokeIpcContractList = Object.values(InvokeIpcContracts);
