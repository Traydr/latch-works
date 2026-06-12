import type { z } from "zod";
import type {
  createSerializedResultSchema,
  DoctorResultSchema,
  LockstepPlanSchema,
  LockstepProfileInputSchema,
  LockstepProfilePatchSchema,
  LockstepProfilePublicSchema,
  LockstepRunEventSchema,
  LockstepRunSummarySchema,
  LockstepSettingsSchema,
  RunRequestSchema,
} from "./contracts";
import type { deserializeIpcResult } from "./ipc";

export type IpcErrorPayload = z.infer<
  typeof import("./contracts").IpcErrorPayloadSchema
>;
export type LockstepPlan = z.infer<typeof LockstepPlanSchema>;
export type LockstepPlanCounts = LockstepPlan["counts"];
export type LockstepPlanItem = LockstepPlan["items"][number];
export type LockstepProfileInput = z.infer<typeof LockstepProfileInputSchema>;
export type LockstepProfilePatch = z.infer<typeof LockstepProfilePatchSchema>;
export type LockstepProfilePublic = z.infer<typeof LockstepProfilePublicSchema>;
export type LockstepRunEvent = z.infer<typeof LockstepRunEventSchema>;
export type LockstepRunSummary = z.infer<typeof LockstepRunSummarySchema>;
export type LockstepSettings = z.infer<typeof LockstepSettingsSchema>;
export type DoctorResult = z.infer<typeof DoctorResultSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;

export type LockstepResult<T> = ReturnType<typeof deserializeIpcResult<T>>;

export interface LockstepApi {
  cancelRun: () => Promise<LockstepResult<void>>;
  createProfile: (input: LockstepProfileInput) => Promise<LockstepResult<LockstepProfilePublic>>;
  deleteProfile: (profileId: string) => Promise<LockstepResult<LockstepSettings>>;
  doctor: (profileId: string) => Promise<LockstepResult<DoctorResult>>;
  getSettings: () => Promise<LockstepResult<LockstepSettings>>;
  onRunEvent: (listener: (event: LockstepRunEvent) => void) => () => void;
  pickSourceFolder: () => Promise<LockstepResult<string | null>>;
  plan: (request: RunRequest) => Promise<LockstepResult<LockstepPlan>>;
  prune: (request: RunRequest) => Promise<LockstepResult<LockstepRunSummary>>;
  push: (request: RunRequest) => Promise<LockstepResult<LockstepRunSummary>>;
  setActiveProfile: (profileId: string) => Promise<LockstepResult<LockstepSettings>>;
  updateProfile: (
    profileId: string,
    patch: LockstepProfilePatch,
  ) => Promise<LockstepResult<LockstepProfilePublic>>;
}

export type SerializedLockstepResult<T> = z.infer<
  ReturnType<typeof createSerializedResultSchema<z.ZodType<T>>>
>;
